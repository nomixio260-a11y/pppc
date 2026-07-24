/**
 * A single conversation's runtime (one ANP network): relay subscription,
 * WebRTC mesh, chat CRDT, membership and Name Service. The browser runs many
 * of these at once (channels + DMs) over one shared identity.
 *
 * Kinds:
 *  - "channel": an open room, joined by name, invite-less.
 *  - "dm":      a private open network for exactly two identities; message
 *               bodies are encrypted with an ECDH shared key so the relay sees
 *               only ciphertext.
 *  - "invite":  a genesis-rooted invite-only network (secondary feature).
 *
 * Persistence is namespaced by network id, so conversations don't collide.
 */

import type { KeyPairHandle } from "../shared/crypto.js";
import { deriveDmKey, dmDecrypt, dmEncrypt, nowSeconds } from "../shared/crypto.js";
import {
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TTL,
  JOIN_TTL,
  createHeartbeat,
  createJoin,
  createLeave,
} from "../shared/events.js";
import { GSetLog, replicaNodeId, signLogEntry, verifyLogEntry, type LogEntry, type VersionVector } from "../shared/crdt.js";
import { nodeIdFromPubkey, verifyInviteChain } from "../shared/identity.js";
import type { AnpEvent, InviteCertificate, JoinEvent, MemberRecord, NodeId, PubKeyHex, Right } from "../shared/types.js";
import type { AnpStore } from "./store.js";
import { RelayPool } from "./relayclient.js";
import { Mesh, type DcMessage } from "./webrtc.js";
import { FileService } from "./files.js";
import type { Reputation } from "../shared/reputation.js";
import type { FileMeta } from "../shared/types.js";

export type ConvKind = "channel" | "dm" | "invite";

export interface ConvSpec {
  network_id: string;
  kind: ConvKind;
  room?: string; // channel name or dm room string
  title: string; // display title
  relays: string[];
  peerPubkey?: PubKeyHex; // dm counterpart
  inviteChain?: InviteCertificate[]; // invite networks
  genesisKeys?: KeyPairHandle; // invite network creator
  isGenesis?: boolean;
}

export interface Identity {
  nodeKeys: KeyPairHandle;
  ecdhKey: CryptoKey;
  myNodeId: NodeId;
  pubkeyHex: PubKeyHex;
}

export interface ConvDeps {
  store: AnpStore;
  reputation: Reputation;
  nickname: () => string;
  /** the active conversation changed (re-render if active) */
  onChange: (conv: Conversation) => void;
  /** new inbound message on a (possibly inactive) conversation */
  onActivity: (conv: Conversation) => void;
  log: (line: string) => void;
}

export interface ChatItem {
  id: string;
  origin: NodeId;
  mine: boolean;
  kind: "chat" | "file";
  text?: string;
  file?: FileMeta;
  ts: number;
}

export interface MemberView {
  node_id: NodeId;
  nickname: string;
  connected: boolean;
  seen: boolean;
  score: number;
  banned: boolean;
  pubkey: PubKeyHex;
}

const ANTI_ENTROPY_MS = 60_000;
const MAX_ENTRIES_PER_DELTA = 512;

export class Conversation {
  readonly spec: ConvSpec;
  unread = 0;
  lastTs = 0;

  private pool?: RelayPool;
  private mesh?: Mesh;
  private files?: FileService;
  private log!: GSetLog;
  private members = new Map<NodeId, MemberRecord>();
  private timers: number[] = [];
  private cachedJoin?: AnpEvent;
  private dmKey?: CryptoKey;
  private myRights: Right[] = [];
  private started = false;
  private nicknames = new Map<NodeId, string>();
  private peerNodeId?: NodeId;

  constructor(
    spec: ConvSpec,
    private readonly id: Identity,
    private readonly deps: ConvDeps,
  ) {
    this.spec = spec;
    this.log = new GSetLog(`${id.myNodeId}`);
  }

  get networkId(): string {
    return this.spec.network_id;
  }
  get kind(): ConvKind {
    return this.spec.kind;
  }
  get title(): string {
    return this.spec.title;
  }

  /** Live display title: DMs resolve to @<peer nickname> once we learn it. */
  displayTitle(): string {
    if (this.spec.kind === "dm" && this.peerNodeId) {
      const nick = this.nicknames.get(this.peerNodeId) ?? this.members.get(this.peerNodeId)?.nickname;
      if (nick) return `@${nick}`;
    }
    return this.spec.title;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // per-conversation epoch keeps entry ids unique across sessions
    const epochKey = `epoch/${this.networkId}`;
    let epoch = await this.deps.store.get<string>("kv", epochKey);
    if (!epoch) {
      epoch = randHex(4);
      await this.deps.store.put("kv", epochKey, epoch);
    }
    const replica = `${this.id.myNodeId}.${epoch}`;
    this.log = GSetLog.fromJSON(replica, (await this.deps.store.get<LogEntry[]>("crdt", `chat/${this.networkId}`)) ?? []);
    for (const m of (await this.deps.store.get<MemberRecord[]>("members", this.networkId)) ?? []) {
      this.members.set(m.node_id, m);
    }

    if (this.spec.kind === "dm" && this.spec.peerPubkey) {
      this.dmKey = await deriveDmKey(this.id.ecdhKey, this.spec.peerPubkey, this.id.pubkeyHex);
      this.peerNodeId = await nodeIdFromPubkey(this.spec.peerPubkey);
    }

    // rights
    if (this.spec.kind === "invite") {
      const check = await verifyInviteChain(this.networkId, this.spec.inviteChain ?? [], this.id.pubkeyHex);
      this.myRights = check.ok ? check.rights : this.spec.isGenesis ? ["join", "invite", "chat", "store", "admin"] : [];
    } else {
      this.myRights = ["join", "chat", "store"];
    }

    this.mesh = new Mesh(this.networkId, this.id.nodeKeys, this.id.ecdhKey, this.id.myNodeId, {
      publishEvent: (event) => this.pool?.publish(event),
      onPeerOpen: (peer) => {
        this.deps.reputation.record(peer.node_id, "connect");
        this.sendHello(peer.node_id);
        this.mesh?.send(peer.node_id, { t: "SYNC_REQ", chat_vv: this.log.versionVector(), profile_lamport: 0 });
        this.deps.onChange(this);
      },
      onPeerClose: (nodeId, reason) => {
        if (reason === "keepalive timeout") this.deps.reputation.record(nodeId, "keepalive-timeout");
        else if (reason?.startsWith("pc ")) this.deps.reputation.record(nodeId, "pc-failed");
        this.deps.onChange(this);
      },
      onMessage: (from, msg) => void this.handleDc(from, msg),
      log: this.deps.log,
    });
    this.files = new FileService(this.deps.store, this.mesh, this.deps.log, {
      rankPeers: (ids) => this.deps.reputation.rank(ids),
      onOutcome: (peer, ok) => this.deps.reputation.record(peer, ok ? "file-served" : "file-failed"),
    });

    this.pool = new RelayPool({
      urls: this.spec.relays,
      filter: { network_id: this.networkId, target: this.id.myNodeId },
      onEvent: (event) => void this.handleRelayEvent(event),
      onStatus: (_url, connected) => {
        this.deps.onChange(this);
        if (connected) void this.announce();
      },
    });
    this.pool.start();

    this.timers.push(
      window.setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL * 1000),
      window.setInterval(() => void this.announce(), 240_000),
      window.setInterval(() => {
        this.mesh?.prune(nowSeconds(), HEARTBEAT_TTL * 2);
        this.deps.onChange(this);
      }, 20_000),
      window.setInterval(() => {
        const peers = this.mesh?.connectedNodeIds() ?? [];
        if (peers.length) {
          const peer = peers[Math.floor(Math.random() * peers.length)]!;
          this.mesh?.send(peer, { t: "SYNC_REQ", chat_vv: this.log.versionVector(), profile_lamport: 0 });
        }
      }, ANTI_ENTROPY_MS),
    );
    this.deps.log(`conversation started: ${this.title}`);
  }

  async stop(): Promise<void> {
    if (this.pool && this.spec.relays.length) {
      try {
        this.pool.publish(await createLeave(this.networkId, this.id.nodeKeys));
      } catch {
        /* ignore */
      }
    }
    this.mesh?.shutdown();
    this.pool?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
  }

  // --- discovery / relay ---

  private async announce(): Promise<void> {
    if (!this.pool) return;
    const now = nowSeconds();
    if (!this.cachedJoin || this.cachedJoin.expires_at - now <= JOIN_TTL / 3) {
      this.cachedJoin =
        this.spec.kind === "invite"
          ? await createJoin(this.networkId, this.id.nodeKeys, this.spec.inviteChain ?? [], this.deps.nickname())
          : await createJoin(this.networkId, this.id.nodeKeys, [], {
              open: true,
              room: this.spec.room,
              nickname: this.deps.nickname(),
            });
    }
    this.pool.publish(this.cachedJoin);
  }

  private async heartbeat(): Promise<void> {
    if (!this.pool) return;
    this.pool.publish(await createHeartbeat(this.networkId, this.id.nodeKeys));
  }

  private async handleRelayEvent(event: AnpEvent): Promise<void> {
    if (!this.mesh) return;
    if (event.node_id !== this.id.myNodeId && this.deps.reputation.isBanned(event.node_id)) return;
    if (event.type === "JOIN" && event.node_id !== this.id.myNodeId) {
      const join = event as JoinEvent;
      const ok = await this.acceptMembership(event.pubkey, join.body.invite_chain, join.body.nickname);
      if (!ok) return;
    }
    await this.mesh.handleDiscoveryEvent(event);
    this.deps.onChange(this);
  }

  private async acceptMembership(pubkey: PubKeyHex, chain: InviteCertificate[], nickname?: string): Promise<boolean> {
    let rights: Right[];
    if (this.spec.kind === "invite") {
      const check = await verifyInviteChain(this.networkId, chain, pubkey);
      if (!check.ok) return false;
      rights = check.rights;
    } else {
      rights = ["join", "chat", "store"];
    }
    const nodeId = await nodeIdFromPubkey(pubkey);
    const existing = this.members.get(nodeId);
    if (existing && existing.pubkey !== pubkey) return false;
    const record: MemberRecord = {
      node_id: nodeId,
      pubkey,
      nickname: nickname ?? existing?.nickname,
      rights,
      invite_chain: chain,
      verified_at: nowSeconds(),
    };
    this.members.set(nodeId, record);
    if (nickname) this.nicknames.set(nodeId, nickname);
    await this.persistMembers();
    return true;
  }

  // --- DataChannel sync ---

  private sendHello(to: NodeId): void {
    this.mesh?.send(to, {
      t: "HELLO",
      node_id: this.id.myNodeId,
      pubkey: this.id.pubkeyHex,
      nickname: this.deps.nickname(),
      chain: this.spec.inviteChain ?? [],
      peers: [...(this.mesh?.peers.values() ?? [])],
    });
  }

  private async handleDc(from: NodeId, msg: DcMessage): Promise<void> {
    if (!this.mesh || !this.files) return;
    if (this.deps.reputation.isBanned(from)) {
      this.mesh.removePeer(from);
      return;
    }
    if (await this.files.handleMessage(from, msg)) {
      if (msg.t === "BLOB_META") this.deps.onChange(this);
      return;
    }
    switch (msg.t) {
      case "HELLO": {
        if (msg.node_id !== from) return;
        if ((await nodeIdFromPubkey(msg.pubkey)) !== from) return;
        await this.acceptMembership(msg.pubkey, msg.chain ?? [], msg.nickname);
        if (msg.nickname) this.nicknames.set(from, msg.nickname);
        this.deps.onChange(this);
        break;
      }
      case "SYNC_REQ": {
        this.mesh.send(from, { t: "CHAT_DELTA", entries: this.log.entriesMissingFrom(msg.chat_vv ?? {}) });
        break;
      }
      case "CHAT_DELTA": {
        await this.acceptEntries(from, msg.entries ?? []);
        break;
      }
      default:
        break;
    }
  }

  private async acceptEntries(from: NodeId, entries: LogEntry[]): Promise<void> {
    const batch = (entries ?? []).slice(0, MAX_ENTRIES_PER_DELTA);
    const good: LogEntry[] = [];
    for (const entry of batch) {
      if (typeof entry?.id !== "string" || (entry.kind !== "chat" && entry.kind !== "file")) continue;
      if (!(await verifyLogEntry(entry))) {
        this.deps.reputation.record(from, "forged-entry");
        continue;
      }
      good.push(entry);
    }
    const added = this.log.merge(good);
    if (added.length) {
      await this.persistChat();
      this.bump(added);
      this.mesh?.broadcast({ t: "CHAT_DELTA", entries: added }, from);
      this.deps.onChange(this);
      this.deps.onActivity(this);
    }
  }

  private bump(added: LogEntry[]): void {
    for (const e of added) {
      if (replicaNodeId(e.origin) !== this.id.myNodeId) this.unread += 1;
      if (e.ts > this.lastTs) this.lastTs = e.ts;
    }
  }

  // --- actions ---

  async sendChat(text: string): Promise<void> {
    let data: unknown;
    if (this.spec.kind === "dm") {
      if (!this.dmKey) throw new Error("DM鍵がありません");
      data = { enc: await dmEncrypt(this.dmKey, text) };
    } else {
      data = { text };
    }
    const entry = this.log.append("chat", data, nowSeconds());
    await signLogEntry(this.id.nodeKeys.privateKey, this.id.pubkeyHex, entry);
    await this.persistChat();
    this.lastTs = entry.ts;
    this.mesh?.broadcast({ t: "CHAT_DELTA", entries: [entry] });
    this.deps.onChange(this);
  }

  async shareFile(file: File): Promise<void> {
    if (!this.files) return;
    const meta = await this.files.shareFile(file);
    const entry = this.log.append("file", meta, nowSeconds());
    await signLogEntry(this.id.nodeKeys.privateKey, this.id.pubkeyHex, entry);
    await this.persistChat();
    this.mesh?.broadcast({ t: "CHAT_DELTA", entries: [entry] });
    this.deps.onChange(this);
  }

  async fetchBlob(meta: FileMeta): Promise<Uint8Array> {
    if (!this.files) throw new Error("not started");
    return this.files.fetchBlob(meta.cid);
  }

  // --- views ---

  async messages(): Promise<ChatItem[]> {
    const out: ChatItem[] = [];
    for (const entry of this.log.ordered()) {
      if (entry.kind !== "chat" && entry.kind !== "file") continue;
      const origin = replicaNodeId(entry.origin);
      const mine = origin === this.id.myNodeId;
      if (entry.kind === "file") {
        out.push({ id: entry.id, origin, mine, kind: "file", file: entry.data as FileMeta, ts: entry.ts });
      } else {
        let text: string;
        const data = entry.data as { text?: string; enc?: { iv: string; ct: string } };
        if (data.enc && this.dmKey) {
          text = (await dmDecrypt(this.dmKey, data.enc)) ?? "🔒(復号できません)";
        } else {
          text = String(data.text ?? "");
        }
        out.push({ id: entry.id, origin, mine, kind: "chat", text, ts: entry.ts });
      }
    }
    return out;
  }

  memberViews(): MemberView[] {
    const connected = new Set(this.mesh?.connectedNodeIds() ?? []);
    const now = nowSeconds();
    return [...(this.mesh?.peers.values() ?? [])]
      .sort((a, b) => a.node_id.localeCompare(b.node_id))
      .map((p) => ({
        node_id: p.node_id,
        nickname: this.nicknameOf(p.node_id),
        connected: connected.has(p.node_id),
        seen: now - p.last_seen <= HEARTBEAT_TTL * 2,
        score: Math.round(this.deps.reputation.scoreOf(p.node_id)),
        banned: this.deps.reputation.isBanned(p.node_id),
        pubkey: p.pubkey,
      }));
  }

  nicknameOf(nodeId: NodeId): string {
    if (nodeId === this.id.myNodeId) return this.deps.nickname();
    return this.nicknames.get(nodeId) ?? this.members.get(nodeId)?.nickname ?? this.mesh?.peers.get(nodeId)?.nickname ?? nodeId.slice(0, 8);
  }

  connectedCount(): number {
    return this.mesh?.connectedNodeIds().length ?? 0;
  }
  relaysUp(): number {
    return this.pool?.connectedCount() ?? 0;
  }
  hasRelays(): boolean {
    return this.spec.relays.length > 0;
  }
  canChat(): boolean {
    return this.myRights.includes("chat");
  }
  clearUnread(): void {
    this.unread = 0;
  }

  private async persistChat(): Promise<void> {
    await this.deps.store.put("crdt", `chat/${this.networkId}`, this.log.toJSON());
  }
  private async persistMembers(): Promise<void> {
    await this.deps.store.put("members", this.networkId, [...this.members.values()]);
  }
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}
