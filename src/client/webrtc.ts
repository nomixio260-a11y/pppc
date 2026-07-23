/**
 * Transport Layer: WebRTC mesh (design doc §9).
 *
 * The relay is only used to exchange SDP (SIGNAL events); once the
 * DataChannel opens, all traffic is peer-to-peer.
 *
 * Connection policy:
 *  - Discovery (JOIN/HEARTBEAT via relay) fills the peer table.
 *  - For each known live peer, the node with the lexicographically SMALLER
 *    node_id initiates the offer. This gives every pair exactly one
 *    initiator and avoids signaling glare.
 *  - Offers/answers are sent non-trickle (wait for ICE gathering) so a
 *    single SIGNAL event each way is enough.
 *
 * DataChannel protocol (JSON messages):
 *   HELLO      {node_id, pubkey, nickname, peers}     — introduction + peer exchange
 *   SYNC_REQ   {chat_lamport, profile_lamport}        — ask for CRDT deltas
 *   CHAT_DELTA {entries}                              — GSetLog delta
 *   PROFILE_DELTA {cells}                             — LwwMap delta
 *   NS         {records}                              — Name Service replication
 */

import type { KeyPairHandle } from "../shared/crypto.js";
import { createSignal, verifyEvent } from "../shared/events.js";
import type { LogEntry, LwwCell } from "../shared/crdt.js";
import type { AnpEvent, NameRecord, NetworkId, NodeId, PeerInfo, SignalEvent } from "../shared/types.js";
import { randomHex } from "../shared/crypto.js";

export type DcMessage =
  | { t: "HELLO"; node_id: NodeId; pubkey: string; nickname?: string; peers: PeerInfo[] }
  | { t: "SYNC_REQ"; chat_lamport: number; profile_lamport: number }
  | { t: "CHAT_DELTA"; entries: LogEntry[] }
  | { t: "PROFILE_DELTA"; cells: Record<string, LwwCell> }
  | { t: "NS"; records: NameRecord[] };

export interface MeshCallbacks {
  publishEvent: (event: AnpEvent) => void;
  onPeerOpen: (peer: PeerInfo) => void;
  onPeerClose: (nodeId: NodeId) => void;
  onMessage: (from: NodeId, msg: DcMessage) => void;
  log: (line: string) => void;
}

interface Link {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  session: string;
  initiator: boolean;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class Mesh {
  /** peers known from discovery (valid JOIN seen) */
  readonly peers = new Map<NodeId, PeerInfo>();
  private links = new Map<NodeId, Link>();

  constructor(
    private readonly networkId: NetworkId,
    private readonly keys: KeyPairHandle,
    private readonly myNodeId: NodeId,
    private readonly cb: MeshCallbacks,
  ) {}

  /** Called for every verified discovery event from the relay pool. */
  async handleDiscoveryEvent(event: AnpEvent): Promise<void> {
    if (event.node_id === this.myNodeId) return;
    switch (event.type) {
      case "JOIN": {
        this.peers.set(event.node_id, {
          node_id: event.node_id,
          pubkey: event.pubkey,
          nickname: event.body.nickname,
          last_seen: event.created_at,
          rights: [],
        });
        this.maybeConnect(event.node_id);
        break;
      }
      case "HEARTBEAT": {
        const peer = this.peers.get(event.node_id);
        if (peer) {
          peer.last_seen = Math.max(peer.last_seen, event.created_at);
          this.maybeConnect(event.node_id);
        }
        break;
      }
      case "LEAVE": {
        this.dropLink(event.node_id, "peer left");
        this.peers.delete(event.node_id);
        this.cb.onPeerClose(event.node_id);
        break;
      }
      case "SIGNAL":
        await this.handleSignal(event);
        break;
      case "MANIFEST":
        break;
    }
  }

  /** Initiate to peers we should connect to (smaller node_id initiates). */
  private maybeConnect(nodeId: NodeId): void {
    if (this.links.has(nodeId)) return;
    if (this.myNodeId < nodeId) void this.initiate(nodeId);
    // otherwise: wait for their offer
  }

  private async initiate(nodeId: NodeId): Promise<void> {
    const session = randomHex(8);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const link: Link = { pc, session, initiator: true };
    this.links.set(nodeId, link);
    this.wirePc(nodeId, link);

    const dc = pc.createDataChannel("anp", { ordered: true });
    this.wireDc(nodeId, link, dc);

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete(pc);
      const event = await createSignal(this.networkId, this.keys, {
        target: nodeId,
        session,
        payload: { kind: "offer", sdp: pc.localDescription!.sdp },
      });
      this.cb.publishEvent(event);
      this.cb.log(`offer -> ${short(nodeId)}`);
    } catch (err) {
      this.cb.log(`offer failed for ${short(nodeId)}: ${(err as Error).message}`);
      this.dropLink(nodeId, "offer failed");
    }
  }

  private async handleSignal(event: SignalEvent): Promise<void> {
    if (event.body.target !== this.myNodeId) return;
    const from = event.node_id;
    // Only talk to authenticated members: a valid JOIN must have been seen.
    // (verifyEvent already validated the signature; membership is the JOIN's
    //  invite chain, so unknown senders are ignored.)
    if (!this.peers.has(from)) {
      this.cb.log(`signal from unknown node ${short(from)} ignored`);
      return;
    }
    const { payload, session } = event.body;

    if (payload.kind === "offer") {
      // The larger node_id answers; if we'd normally initiate, still answer
      // (their view of us may be newer) but drop our half-open attempt.
      const existing = this.links.get(from);
      if (existing) {
        if (existing.session === session) return; // duplicate
        this.dropLink(from, "superseded by incoming offer");
      }
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const link: Link = { pc, session, initiator: false };
      this.links.set(from, link);
      this.wirePc(from, link);
      pc.ondatachannel = (ev) => this.wireDc(from, link, ev.channel);
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await waitIceComplete(pc);
        const answer = await createSignal(this.networkId, this.keys, {
          target: from,
          session,
          payload: { kind: "answer", sdp: pc.localDescription!.sdp },
        });
        this.cb.publishEvent(answer);
        this.cb.log(`answer -> ${short(from)}`);
      } catch (err) {
        this.cb.log(`answer failed for ${short(from)}: ${(err as Error).message}`);
        this.dropLink(from, "answer failed");
      }
    } else if (payload.kind === "answer") {
      const link = this.links.get(from);
      if (!link || link.session !== session || !link.initiator) return;
      try {
        await link.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } catch (err) {
        this.cb.log(`bad answer from ${short(from)}: ${(err as Error).message}`);
        this.dropLink(from, "bad answer");
      }
    }
  }

  private wirePc(nodeId: NodeId, link: Link): void {
    link.pc.onconnectionstatechange = () => {
      const state = link.pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        if (this.links.get(nodeId) === link) {
          this.dropLink(nodeId, state);
          this.cb.onPeerClose(nodeId);
        }
      }
    };
  }

  private wireDc(nodeId: NodeId, link: Link, dc: RTCDataChannel): void {
    link.dc = dc;
    dc.onopen = () => {
      const peer = this.peers.get(nodeId);
      if (peer) this.cb.onPeerOpen(peer);
      this.cb.log(`datachannel open: ${short(nodeId)}`);
    };
    dc.onmessage = (ev) => {
      try {
        this.cb.onMessage(nodeId, JSON.parse(String(ev.data)) as DcMessage);
      } catch {
        /* ignore malformed */
      }
    };
    dc.onclose = () => {
      if (this.links.get(nodeId) === link) {
        this.dropLink(nodeId, "datachannel closed");
        this.cb.onPeerClose(nodeId);
      }
    };
  }

  private dropLink(nodeId: NodeId, reason: string): void {
    const link = this.links.get(nodeId);
    if (!link) return;
    this.links.delete(nodeId);
    try {
      link.dc?.close();
      link.pc.close();
    } catch {
      /* already closed */
    }
    this.cb.log(`link ${short(nodeId)} dropped (${reason})`);
  }

  send(nodeId: NodeId, msg: DcMessage): boolean {
    const dc = this.links.get(nodeId)?.dc;
    if (!dc || dc.readyState !== "open") return false;
    dc.send(JSON.stringify(msg));
    return true;
  }

  broadcast(msg: DcMessage): number {
    let sent = 0;
    for (const nodeId of this.links.keys()) {
      if (this.send(nodeId, msg)) sent++;
    }
    return sent;
  }

  connectedNodeIds(): NodeId[] {
    const out: NodeId[] = [];
    for (const [nodeId, link] of this.links) {
      if (link.dc?.readyState === "open") out.push(nodeId);
    }
    return out;
  }

  /** Drop peers whose heartbeat lapsed and who have no open channel. */
  prune(now: number, ttl: number): void {
    for (const [nodeId, peer] of this.peers) {
      const open = this.links.get(nodeId)?.dc?.readyState === "open";
      if (!open && now - peer.last_seen > ttl) {
        this.dropLink(nodeId, "stale");
        this.peers.delete(nodeId);
        this.cb.onPeerClose(nodeId);
      }
    }
  }

  shutdown(): void {
    for (const nodeId of [...this.links.keys()]) this.dropLink(nodeId, "shutdown");
  }
}

function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000); // don't block forever on STUN
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        resolve();
      }
    };
  });
}

function short(id: string): string {
  return id.slice(0, 8);
}

// re-export so verifyEvent tree-shakes into the bundle once
export { verifyEvent };
