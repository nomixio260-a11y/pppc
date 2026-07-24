/**
 * Transport Layer: WebRTC mesh (design doc §9), protocol v2.
 *
 * The relay is only used to exchange E2E-encrypted SDP/ICE (SIGNAL events);
 * once the DataChannel opens, all traffic is peer-to-peer.
 *
 * Connection policy:
 *  - Discovery (JOIN/HEARTBEAT via relay) fills the peer table.
 *  - For each known live peer, the node with the lexicographically SMALLER
 *    node_id initiates the offer. This gives every pair exactly one
 *    initiator and avoids signaling glare.
 *  - Trickle ICE: candidates stream as encrypted `ice` signals, so
 *    connections start as soon as the first viable pair is found.
 *  - Every handshake has a hard deadline; failed/stalled attempts are torn
 *    down and retried with exponential backoff, so a lost SIGNAL can never
 *    wedge a pair forever.
 *  - DataChannel liveness is tracked with PING/PONG; silent links get
 *    dropped and re-established.
 *
 * Security:
 *  - SIGNAL payloads are ECIES-encrypted to the target node's key: relays
 *    never see SDP (contains IPs) and cannot inject candidates.
 *  - Per-session sequence numbers reject replayed signals.
 *  - Signals from nodes without a verified JOIN are ignored.
 */

import type { KeyPairHandle } from "../shared/crypto.js";
import { createSignal, decryptSignal } from "../shared/events.js";
import type { LogEntry, LwwCell, VersionVector } from "../shared/crdt.js";
import type {
  AnpEvent,
  InviteCertificate,
  NameRecord,
  NetworkId,
  NodeId,
  PeerInfo,
  SignalEvent,
} from "../shared/types.js";
import { nowSeconds, randomHex } from "../shared/crypto.js";

export type DcMessage =
  | { t: "HELLO"; node_id: NodeId; pubkey: string; nickname?: string; chain: InviteCertificate[]; peers: PeerInfo[] }
  | { t: "SYNC_REQ"; chat_vv: VersionVector; profile_lamport: number }
  | { t: "CHAT_DELTA"; entries: LogEntry[] }
  | { t: "PROFILE_DELTA"; cells: Record<string, LwwCell> }
  | { t: "NS"; records: NameRecord[] }
  | { t: "MEMBER_REQ"; node_id: NodeId }
  | { t: "MEMBER_PROOF"; node_id: NodeId; pubkey: string; nickname?: string; chain: InviteCertificate[] }
  | { t: "PING"; ts: number }
  | { t: "PONG"; ts: number }
  | { t: "BLOB_REQ"; cid: string }
  | { t: "BLOB_META"; cid: string; size: number; chunks: number; name?: string; mime?: string }
  | { t: "BLOB_CHUNK"; cid: string; idx: number; data: string }
  | { t: "BLOB_ERR"; cid: string; reason: string };

export interface MeshCallbacks {
  publishEvent: (event: AnpEvent) => void;
  onPeerOpen: (peer: PeerInfo) => void;
  onPeerClose: (nodeId: NodeId) => void;
  onMessage: (from: NodeId, msg: DcMessage) => void;
  log: (line: string) => void;
}

type LinkState = "connecting" | "open";

interface Link {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  session: string;
  initiator: boolean;
  state: LinkState;
  peerPubkey: string;
  /** outgoing signal sequence for this session */
  txSeq: number;
  /** incoming seqs already processed (replay/duplicate rejection) */
  rxSeen: Set<number>;
  /** ICE candidates received before the remote description was set */
  pendingCandidates: RTCIceCandidateInit[];
  haveRemote: boolean;
  /** unix seconds when this session began (offer created_at for responders) */
  sessionStartedAt: number;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  lastPongAt: number;
  pingTimer?: ReturnType<typeof setInterval>;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const HANDSHAKE_TIMEOUT_MS = 25_000;
const PING_INTERVAL_MS = 15_000;
const PONG_DEADLINE_MS = 50_000;
const RETRY_BASE_MS = 4_000;
const RETRY_MAX_MS = 60_000;
/** upper bound on a single DataChannel frame; a base64 16 KiB blob chunk plus
 * envelope fits well under this, so it only rejects abusive oversized frames */
const MAX_DC_FRAME_BYTES = 512 * 1024;

export class Mesh {
  /** peers known from discovery (valid JOIN seen) */
  readonly peers = new Map<NodeId, PeerInfo>();
  private links = new Map<NodeId, Link>();
  /** per-peer reconnect backoff */
  private attempts = new Map<NodeId, { count: number; nextAt: number }>();
  private retryTimers = new Map<NodeId, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private readonly networkId: NetworkId,
    private readonly keys: KeyPairHandle,
    private readonly ecdhKey: CryptoKey,
    private readonly myNodeId: NodeId,
    private readonly cb: MeshCallbacks,
  ) {}

  /** Called for every verified discovery event from the relay pool. */
  async handleDiscoveryEvent(event: AnpEvent): Promise<void> {
    if (this.stopped || event.node_id === this.myNodeId) return;
    switch (event.type) {
      case "JOIN": {
        const existing = this.peers.get(event.node_id);
        this.peers.set(event.node_id, {
          node_id: event.node_id,
          pubkey: event.pubkey,
          nickname: event.body.nickname ?? existing?.nickname,
          last_seen: Math.max(event.created_at, existing?.last_seen ?? 0),
          rights: existing?.rights ?? [],
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
        // multi-relay replay can deliver an old LEAVE after a newer JOIN or
        // HEARTBEAT — only honor a LEAVE newer than the peer's last activity,
        // and never honor one while a live DataChannel proves the peer is up
        const peer = this.peers.get(event.node_id);
        if (peer && event.created_at < peer.last_seen) break;
        const liveLink = this.links.get(event.node_id);
        if (liveLink?.state === "open" && liveLink.dc?.readyState === "open") break;
        this.dropLinkById(event.node_id, "peer left");
        this.peers.delete(event.node_id);
        this.clearRetry(event.node_id);
        // clear backoff too, so a quick leave/rejoin reconnects immediately
        // (matches removePeer/prune; otherwise stale backoff stalls it ~1min)
        this.attempts.delete(event.node_id);
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
    if (this.stopped || this.links.has(nodeId)) return;
    if (this.myNodeId >= nodeId) return; // the smaller id initiates; we wait
    const attempt = this.attempts.get(nodeId);
    if (attempt && Date.now() < attempt.nextAt) return; // still backing off
    void this.initiate(nodeId);
  }

  private recordFailure(nodeId: NodeId): void {
    const attempt = this.attempts.get(nodeId) ?? { count: 0, nextAt: 0 };
    attempt.count += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt.count - 1));
    const jitter = delay * (0.5 + Math.random() * 0.5);
    attempt.nextAt = Date.now() + jitter;
    this.attempts.set(nodeId, attempt);
    // proactive retry: don't wait for the next heartbeat to trigger maybeConnect
    this.clearRetry(nodeId);
    if (this.stopped) return;
    this.retryTimers.set(
      nodeId,
      setTimeout(() => {
        this.retryTimers.delete(nodeId);
        if (this.peers.has(nodeId)) this.maybeConnect(nodeId);
      }, jitter + 100),
    );
  }

  private clearRetry(nodeId: NodeId): void {
    const timer = this.retryTimers.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(nodeId);
    }
  }

  private newLink(
    nodeId: NodeId,
    session: string,
    initiator: boolean,
    peerPubkey: string,
    sessionStartedAt: number,
  ): Link {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const link: Link = {
      pc,
      session,
      initiator,
      state: "connecting",
      peerPubkey,
      txSeq: 0,
      rxSeen: new Set(),
      pendingCandidates: [],
      haveRemote: false,
      sessionStartedAt,
      lastPongAt: Date.now(),
    };
    this.links.set(nodeId, link);

    link.handshakeTimer = setTimeout(() => {
      if (this.links.get(nodeId) === link && link.state !== "open") {
        this.dropLink(nodeId, link, "handshake timeout");
        this.recordFailure(nodeId);
      }
    }, HANDSHAKE_TIMEOUT_MS);

    pc.onicecandidate = (ev) => {
      if (this.links.get(nodeId) !== link) return;
      // trickle: forward each candidate (and the null end-of-candidates marker)
      void this.sendSignal(nodeId, link, { kind: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (this.links.get(nodeId) !== link) return;
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.dropLink(nodeId, link, `pc ${state}`);
        this.recordFailure(nodeId);
        this.cb.onPeerClose(nodeId);
      }
    };
    return link;
  }

  private async sendSignal(
    nodeId: NodeId,
    link: Link,
    payload: Parameters<typeof createSignal>[6],
  ): Promise<void> {
    try {
      const event = await createSignal(
        this.networkId,
        this.keys,
        nodeId,
        link.peerPubkey,
        link.session,
        link.txSeq++,
        payload,
      );
      this.cb.publishEvent(event);
    } catch (err) {
      this.cb.log(`signal encrypt failed for ${short(nodeId)}: ${(err as Error).message}`);
    }
  }

  private async initiate(nodeId: NodeId): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    const session = randomHex(8);
    const link = this.newLink(nodeId, session, true, peer.pubkey, nowSeconds());
    const dc = link.pc.createDataChannel("anp", { ordered: true });
    this.wireDc(nodeId, link, dc);

    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      if (this.links.get(nodeId) !== link) return;
      await this.sendSignal(nodeId, link, { kind: "offer", sdp: link.pc.localDescription!.sdp });
      this.cb.log(`offer -> ${short(nodeId)} (session ${session})`);
    } catch (err) {
      this.cb.log(`offer failed for ${short(nodeId)}: ${(err as Error).message}`);
      if (this.links.get(nodeId) === link) {
        this.dropLink(nodeId, link, "offer failed");
        this.recordFailure(nodeId);
      }
    }
  }

  private async handleSignal(event: SignalEvent): Promise<void> {
    if (event.body.target !== this.myNodeId) return;
    const from = event.node_id;
    // Only talk to authenticated members: a valid JOIN must have been seen.
    const peer = this.peers.get(from);
    if (!peer) {
      this.cb.log(`signal from unknown node ${short(from)} ignored`);
      return;
    }
    if (peer.pubkey !== event.pubkey) return; // key mismatch — ignore

    const { session, seq } = event.body;
    const payload = await decryptSignal(this.ecdhKey, this.keys.publicKeyHex, event.body.enc);
    if (!payload) {
      this.cb.log(`undecryptable signal from ${short(from)} dropped`);
      return;
    }

    if (payload.kind === "offer") {
      const existing = this.links.get(from);
      if (existing) {
        if (existing.session === session) return; // duplicate offer for the live session
        // A relay REQ backlog can replay an *older* offer after we already
        // accepted a newer session — only strictly newer offers supersede.
        if (event.created_at <= existing.sessionStartedAt) return;
        if (existing.state === "open") {
          // A fresh offer while we hold an open link means the peer restarted:
          // trust the newer intent, tear down, and answer the new session.
          this.dropLink(from, existing, "superseded by new offer");
        } else if (existing.initiator) {
          // glare (both sides initiated): deterministic winner — the smaller
          // node id keeps its offer, the larger yields and answers.
          if (this.myNodeId < from) return; // we win; ignore their offer
          this.dropLink(from, existing, "glare: yielding to smaller node id");
        } else {
          // two concurrent offers from the same peer: keep only the newest
          this.dropLink(from, existing, "superseded by newer offer session");
        }
      }
      const link = this.newLink(from, session, false, peer.pubkey, event.created_at);
      if (!link.rxSeen.has(seq)) link.rxSeen.add(seq);
      link.pc.ondatachannel = (ev) => this.wireDc(from, link, ev.channel);
      try {
        await link.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        if (this.links.get(from) !== link) return;
        link.haveRemote = true;
        await this.flushCandidates(link);
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        if (this.links.get(from) !== link) return;
        await this.sendSignal(from, link, { kind: "answer", sdp: link.pc.localDescription!.sdp });
        this.cb.log(`answer -> ${short(from)} (session ${session})`);
      } catch (err) {
        this.cb.log(`answer failed for ${short(from)}: ${(err as Error).message}`);
        if (this.links.get(from) === link) {
          this.dropLink(from, link, "answer failed");
          this.recordFailure(from);
        }
      }
      return;
    }

    // answer / ice must match the live session exactly
    const link = this.links.get(from);
    if (!link || link.session !== session) return;
    if (link.rxSeen.has(seq)) return; // replay
    link.rxSeen.add(seq);

    if (payload.kind === "answer") {
      if (!link.initiator || link.haveRemote) return;
      try {
        await link.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        if (this.links.get(from) !== link) return;
        link.haveRemote = true;
        await this.flushCandidates(link);
      } catch (err) {
        this.cb.log(`bad answer from ${short(from)}: ${(err as Error).message}`);
        if (this.links.get(from) === link) {
          this.dropLink(from, link, "bad answer");
          this.recordFailure(from);
        }
      }
    } else if (payload.kind === "ice") {
      if (payload.candidate === null) return; // end-of-candidates marker
      if (link.haveRemote) {
        try {
          await link.pc.addIceCandidate(payload.candidate);
        } catch {
          /* stale candidate — harmless */
        }
      } else {
        if (link.pendingCandidates.length < 64) link.pendingCandidates.push(payload.candidate);
      }
    }
  }

  private async flushCandidates(link: Link): Promise<void> {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await link.pc.addIceCandidate(candidate);
      } catch {
        /* stale candidate — harmless */
      }
    }
  }

  private wireDc(nodeId: NodeId, link: Link, dc: RTCDataChannel): void {
    link.dc = dc;
    dc.onopen = () => {
      if (this.links.get(nodeId) !== link) return;
      link.state = "open";
      link.lastPongAt = Date.now();
      if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
      this.attempts.delete(nodeId); // success resets backoff
      this.clearRetry(nodeId);
      link.pingTimer = setInterval(() => {
        if (this.links.get(nodeId) !== link) return;
        if (Date.now() - link.lastPongAt > PONG_DEADLINE_MS) {
          this.dropLink(nodeId, link, "keepalive timeout");
          this.recordFailure(nodeId);
          this.cb.onPeerClose(nodeId);
          return;
        }
        this.sendOn(link, { t: "PING", ts: Date.now() });
      }, PING_INTERVAL_MS);
      const peer = this.peers.get(nodeId);
      if (peer) this.cb.onPeerOpen(peer);
      this.cb.log(`datachannel open: ${short(nodeId)}`);
    };
    dc.onmessage = (ev) => {
      if (this.links.get(nodeId) !== link) return;
      const raw = String(ev.data);
      if (raw.length > MAX_DC_FRAME_BYTES) return; // oversized frame — drop
      let msg: DcMessage;
      try {
        msg = JSON.parse(raw) as DcMessage;
      } catch {
        return; // malformed
      }
      if (msg.t === "PING") {
        this.sendOn(link, { t: "PONG", ts: msg.ts });
        return;
      }
      if (msg.t === "PONG") {
        link.lastPongAt = Date.now();
        return;
      }
      this.cb.onMessage(nodeId, msg);
    };
    dc.onclose = () => {
      if (this.links.get(nodeId) !== link) return;
      this.dropLink(nodeId, link, "datachannel closed");
      this.recordFailure(nodeId);
      this.cb.onPeerClose(nodeId);
    };
  }

  /** Drop only if `link` is still the current link for `nodeId`. */
  private dropLink(nodeId: NodeId, link: Link, reason: string): void {
    if (this.links.get(nodeId) !== link) return;
    this.links.delete(nodeId);
    if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
    if (link.pingTimer) clearInterval(link.pingTimer);
    try {
      link.dc?.close();
      link.pc.close();
    } catch {
      /* already closed */
    }
    this.cb.log(`link ${short(nodeId)} dropped (${reason})`);
  }

  private dropLinkById(nodeId: NodeId, reason: string): void {
    const link = this.links.get(nodeId);
    if (link) this.dropLink(nodeId, link, reason);
  }

  private sendOn(link: Link, msg: DcMessage): boolean {
    if (!link.dc || link.dc.readyState !== "open") return false;
    try {
      link.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  send(nodeId: NodeId, msg: DcMessage): boolean {
    const link = this.links.get(nodeId);
    return link ? this.sendOn(link, msg) : false;
  }

  /** Raw accessor for backpressure-aware bulk transfers (file service). */
  channelOf(nodeId: NodeId): RTCDataChannel | undefined {
    const dc = this.links.get(nodeId)?.dc;
    return dc?.readyState === "open" ? dc : undefined;
  }

  broadcast(msg: DcMessage, except?: NodeId): number {
    let sent = 0;
    for (const [nodeId, link] of this.links) {
      if (nodeId === except) continue;
      if (this.sendOn(link, msg)) sent++;
    }
    return sent;
  }

  connectedNodeIds(): NodeId[] {
    const out: NodeId[] = [];
    for (const [nodeId, link] of this.links) {
      if (link.state === "open" && link.dc?.readyState === "open") out.push(nodeId);
    }
    return out;
  }

  /** Forcibly remove a peer (e.g. after its invite was revoked). */
  removePeer(nodeId: NodeId): void {
    this.dropLinkById(nodeId, "removed");
    this.peers.delete(nodeId);
    this.clearRetry(nodeId);
    this.attempts.delete(nodeId);
    this.cb.onPeerClose(nodeId);
  }

  /** Drop peers whose heartbeat lapsed and who have no open channel. */
  prune(now: number, ttl: number): void {
    for (const [nodeId, peer] of this.peers) {
      const link = this.links.get(nodeId);
      const open = link?.state === "open" && link.dc?.readyState === "open";
      if (!open && now - peer.last_seen > ttl) {
        this.dropLinkById(nodeId, "stale");
        this.peers.delete(nodeId);
        this.clearRetry(nodeId);
        this.attempts.delete(nodeId);
        this.cb.onPeerClose(nodeId);
      }
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const [nodeId, link] of [...this.links]) this.dropLink(nodeId, link, "shutdown");
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}

export { nowSeconds };
