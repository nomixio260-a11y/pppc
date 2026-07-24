/**
 * ANP browser node — application wiring (protocol v2).
 *
 * Boot flow (design doc §8):
 *   creator:  genesis keys -> network id -> self-invite cert -> JOIN
 *   invitee:  node keys -> join request code -> invite bundle -> verify -> JOIN
 *
 * After JOIN the node subscribes on the relay pool, forms a WebRTC mesh with
 * every live peer, and synchronizes the chat CRDT, profile CRDT, the Name
 * Service record set and content-addressed files over DataChannels.
 *
 * v2 additions:
 *  - membership registry: only entries/cells signed by verified members are
 *    merged; unknown origins are resolved with MEMBER_REQ/MEMBER_PROOF
 *  - invite revocation, replicated as name-service records and enforced
 *    against live peers
 *  - invite links (#invite=...), identity export/import, sendBeacon LEAVE,
 *    version-vector chat sync, per-relay health display
 */

import {
  type KeyPairHandle,
  type StoredKeyPair,
  exportKeyPair,
  generateKeyPair,
  importKeyPair,
  importPrivateKeyForEcdh,
  nowSeconds,
  randomHex,
} from "../shared/crypto.js";
import {
  anpUrl,
  decodeInviteBundle,
  encodeInviteBundle,
  issueCertificate,
  networkIdFromGenesisPubkey,
  nodeIdFromPubkey,
  verifyInviteChain,
} from "../shared/identity.js";
import {
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TTL,
  JOIN_TTL,
  createHeartbeat,
  createJoin,
  createLeave,
  createManifest,
} from "../shared/events.js";
import {
  GSetLog,
  LwwMap,
  replicaNodeId,
  signCell,
  signLogEntry,
  verifyCell,
  verifyLogEntry,
  type LogEntry,
  type LwwCell,
} from "../shared/crdt.js";
import { NameServiceStore, REVOKED_PREFIX, createNameRecord } from "../shared/nameservice.js";
import type {
  AnpEvent,
  FileMeta,
  InviteBundle,
  InviteCertificate,
  JoinEvent,
  MemberRecord,
  NameRecord,
  NodeId,
  RevocationMap,
  Right,
} from "../shared/types.js";
import { AnpStore } from "./store.js";
import { RelayPool } from "./relayclient.js";
import { Mesh, type DcMessage } from "./webrtc.js";
import { FileService } from "./files.js";

interface NodeConfig {
  network_id: string;
  relays: string[];
  nickname: string;
  is_genesis: boolean;
}

interface IssuedInvite {
  invite_id: string;
  subject_pubkey: string;
  rights: Right[];
  issued_at: number;
  issued_by: "genesis" | "node";
  revoked?: boolean;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

function short(id: string): string {
  return id ? `${id.slice(0, 12)}…` : "";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function defaultRelays(): string[] {
  if (location.protocol.startsWith("http")) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return [`${proto}//${location.host}`];
  }
  return ["ws://localhost:8787"];
}

function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function toast(message: string, kind: "info" | "ok" | "error" = "info"): void {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 4000);
}

function log(line: string): void {
  const el = $("log");
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${line}\n${el.textContent ?? ""}`.slice(0, 20_000);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let store: AnpStore;
let config: NodeConfig | undefined;
let nodeKeys: KeyPairHandle | undefined;
let nodeStoredKeys: StoredKeyPair | undefined;
let genesisKeys: KeyPairHandle | undefined;
let inviteChain: InviteCertificate[] = [];
let issuedInvites: IssuedInvite[] = [];
let myRights: Right[] = [];
let myNodeId = "";

let pool: RelayPool | undefined;
let mesh: Mesh | undefined;
let files: FileService | undefined;
let chatLog: GSetLog | undefined;
let profileMap: LwwMap | undefined;
let nameService: NameServiceStore | undefined;
let revocations: RevocationMap = new Map();
let latestLeave: AnpEvent | undefined;
let cachedJoin: AnpEvent | undefined;
let timers: number[] = [];

/** verified members: node_id -> record (from JOIN events and MEMBER_PROOFs) */
const members = new Map<NodeId, MemberRecord>();
/** chat entries whose origin membership is not yet proven (keyed by node id) */
const pendingEntries = new Map<NodeId, { entries: LogEntry[]; since: number }>();
const MAX_PENDING = 500;
/** origins we've already asked a proof for recently */
const proofRequested = new Map<NodeId, number>();
/** interval for periodic anti-entropy with a random connected peer */
const ANTI_ENTROPY_MS = 60_000;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistChat(): Promise<void> {
  if (chatLog) await store.put("crdt", "chat", chatLog.toJSON());
}
async function persistProfile(): Promise<void> {
  if (profileMap) await store.put("crdt", "profile", profileMap.toJSON());
}
async function persistNs(): Promise<void> {
  if (!nameService) return;
  for (const record of nameService.all()) await store.put("ns", record.name, record);
}
async function persistIssued(): Promise<void> {
  await store.put("kv", "issuedInvites", issuedInvites);
}

// ---------------------------------------------------------------------------
// Membership registry
// ---------------------------------------------------------------------------

async function registerMember(
  nodeId: NodeId,
  pubkey: string,
  chain: InviteCertificate[],
  nickname: string | undefined,
  rights: Right[],
  historical = false,
): Promise<boolean> {
  const existing = members.get(nodeId);
  if (existing && existing.pubkey !== pubkey) return false; // key substitution attempt
  if (existing && !existing.historical && historical) return false; // never downgrade
  const record: MemberRecord = {
    node_id: nodeId,
    pubkey,
    nickname: nickname ?? existing?.nickname,
    rights,
    invite_chain: chain,
    verified_at: nowSeconds(),
    historical,
  };
  members.set(nodeId, record);
  await store.put("members", nodeId, record);
  flushPending(nodeId);
  return true;
}

/**
 * Verify pubkey+chain against the network and (current) revocation set.
 * `forHistory` relaxes only certificate expiry: it lets a new node
 * authenticate chat history written by members whose certs later lapsed,
 * but is never used for live connections or NS-write authorization.
 */
async function verifyMembership(
  pubkey: string,
  chain: InviteCertificate[],
  forHistory = false,
): Promise<{ ok: boolean; rights: Right[]; reason?: string }> {
  if (!config) return { ok: false, rights: [], reason: "not joined" };
  return verifyInviteChain(config.network_id, chain, pubkey, nowSeconds(), revocations, forHistory);
}

function flushPending(origin: NodeId): void {
  const pending = pendingEntries.get(origin);
  if (!pending || !chatLog) return;
  pendingEntries.delete(origin);
  const added = chatLog.merge(pending.entries);
  if (added.length) {
    void persistChat();
    renderChat();
  }
}

function genesisPubkeyHex(): string | undefined {
  return genesisKeys?.publicKeyHex ?? inviteChain[0]?.issuer_pubkey;
}

/**
 * Name Service write authorization: records are only merged when their
 * author is the genesis key, ourselves, or a verified member. Prevents a
 * non-member (whose events a relay might still carry) from poisoning
 * replicated names with high-version records.
 */
function isAuthorizedNsAuthor(pubkey: string): boolean {
  if (pubkey === genesisPubkeyHex() || pubkey === nodeKeys?.publicKeyHex) return true;
  for (const member of members.values()) {
    if (member.pubkey === pubkey && !member.historical) return true;
  }
  return false;
}

async function mergeNsRecords(records: NameRecord[], from?: NodeId): Promise<boolean> {
  if (!nameService) return false;
  const merged: NameRecord[] = [];
  for (const record of records ?? []) {
    if (!record || typeof record.author_pubkey !== "string") continue;
    if (!isAuthorizedNsAuthor(record.author_pubkey)) continue;
    if (await nameService.merge(record)) merged.push(record);
  }
  if (merged.length) {
    await persistNs();
    await applyRevocations();
    renderNs();
    // gossip newly-won records onward (terminates: re-merge returns false)
    mesh?.broadcast({ t: "NS", records: merged }, from);
  }
  return merged.length > 0;
}

/** Re-check every member and live peer against the latest revocation set. */
async function applyRevocations(): Promise<void> {
  if (!config || !nameService) return;
  revocations = nameService.revocations();
  if (revocations.size === 0) return;
  for (const [nodeId, member] of [...members]) {
    if (member.invite_chain.length === 0) continue; // genesis node
    // historical members are only re-checked for revocation, not expiry
    const check = await verifyMembership(member.pubkey, member.invite_chain, member.historical ?? false);
    if (!check.ok) {
      members.delete(nodeId);
      await store.delete("members", nodeId);
      mesh?.removePeer(nodeId);
      log(`member ${short(nodeId)} removed: ${check.reason}`);
      toast(`メンバー ${short(nodeId)} の招待が失効しました`, "info");
    }
  }
  if (nodeKeys && !genesisKeys) {
    const own = await verifyMembership(nodeKeys.publicKeyHex, inviteChain);
    if (!own.ok) {
      toast(`あなたの招待は失効しています: ${own.reason}`, "error");
    }
  }
  renderPeers();
}

// ---------------------------------------------------------------------------
// Setup flows
// ---------------------------------------------------------------------------

async function createNetwork(nickname: string, relays: string[]): Promise<void> {
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join", "invite", "chat", "store", "admin"],
  });
  await store.put("kv", "genesisKeys", await exportKeyPair(genesis));
  await store.put("kv", "nodeKeys", await exportKeyPair(node));
  await store.put("kv", "inviteChain", [cert]);
  const cfg: NodeConfig = { network_id: networkId, relays, nickname, is_genesis: true };
  await store.put("kv", "config", cfg);
  toast(`ネットワークを作成しました`, "ok");
  log(`network created: ${anpUrl(networkId)}`);
  await boot();
}

async function prepareJoinRequest(): Promise<string> {
  let storedKeys = await store.get<StoredKeyPair>("kv", "pendingKeys");
  if (!storedKeys) {
    const keys = await generateKeyPair();
    storedKeys = await exportKeyPair(keys);
    await store.put("kv", "pendingKeys", storedKeys);
  }
  return storedKeys.publicKeyHex;
}

async function acceptInvite(bundleText: string, nickname: string): Promise<void> {
  const bundle: InviteBundle = decodeInviteBundle(bundleText);
  const storedKeys = await store.get<StoredKeyPair>("kv", "pendingKeys");
  if (!storedKeys) throw new Error("先に参加リクエストコードを作成してください");
  const check = await verifyInviteChain(bundle.network_id, bundle.chain, storedKeys.publicKeyHex);
  if (!check.ok) throw new Error(`招待証明書が不正です: ${check.reason}`);
  await store.put("kv", "nodeKeys", storedKeys);
  await store.put("kv", "inviteChain", bundle.chain);
  await store.delete("kv", "pendingKeys");
  const cfg: NodeConfig = {
    network_id: bundle.network_id,
    relays: bundle.relays.length ? bundle.relays : defaultRelays(),
    nickname,
    is_genesis: false,
  };
  await store.put("kv", "config", cfg);
  toast("参加しました", "ok");
  log(`invite accepted for ${anpUrl(bundle.network_id)}`);
  history.replaceState(null, "", location.pathname); // drop #invite=… from the URL
  await boot();
}

async function issueInvite(subjectPubkey: string, grantInvite: boolean): Promise<{ bundle: string; link: string }> {
  if (!config || !nodeKeys) throw new Error("not joined");
  if (!/^[0-9a-f]{130}$/.test(subjectPubkey)) throw new Error("参加リクエストコードの形式が不正です");
  const rights: Right[] = grantInvite ? ["join", "invite", "chat", "store"] : ["join", "chat", "store"];
  let chain: InviteCertificate[];
  let cert: InviteCertificate;
  if (genesisKeys) {
    // creator: issue directly from the genesis key — shortest possible chain
    cert = await issueCertificate({
      networkId: config.network_id,
      issuer: genesisKeys,
      subjectPubkey,
      rights,
    });
    chain = [cert];
  } else {
    if (!myRights.includes("invite")) throw new Error("このノードには招待権がありません");
    cert = await issueCertificate({
      networkId: config.network_id,
      issuer: nodeKeys,
      subjectPubkey,
      rights,
    });
    chain = [...inviteChain, cert];
  }
  issuedInvites.push({
    invite_id: cert.invite_id,
    subject_pubkey: subjectPubkey,
    rights,
    issued_at: nowSeconds(),
    issued_by: genesisKeys ? "genesis" : "node",
  });
  await persistIssued();
  renderInvites();
  const bundle: InviteBundle = {
    v: 1,
    network_id: config.network_id,
    genesis_pubkey: genesisKeys?.publicKeyHex ?? inviteChain[0]!.issuer_pubkey,
    relays: config.relays,
    chain,
  };
  const encoded = encodeInviteBundle(bundle);
  const link = location.protocol.startsWith("http")
    ? `${location.origin}${location.pathname}#invite=${encoded}`
    : "";
  return { bundle: encoded, link };
}

async function revokeInvite(inviteId: string): Promise<void> {
  if (!config || !nodeKeys || !nameService || !pool) throw new Error("not joined");
  const invite = issuedInvites.find((inv) => inv.invite_id === inviteId);
  if (!invite) throw new Error("unknown invite");
  const keys = invite.issued_by === "genesis" ? genesisKeys : nodeKeys;
  if (!keys) throw new Error("発行鍵がありません");
  const name = `${REVOKED_PREFIX}${inviteId}`;
  const existing = nameService.resolve(name);
  const record = await createNameRecord(
    config.network_id,
    keys,
    name,
    { kind: "revocation", invite_id: inviteId },
    (existing?.version ?? 0) + 1,
    365 * 24 * 3600, // revocations live long
  );
  await nameService.merge(record);
  await persistNs();
  invite.revoked = true;
  await persistIssued();

  // Propagate the revocation BEFORE ejecting anyone. Ejection closes our
  // DataChannels to the affected peers, and a channel close can discard
  // still-buffered sends — so if we ejected first, a directly-connected
  // revoked peer (and its downstream) might never learn it was revoked and
  // would keep vouching for the sub-tree. Broadcast to every peer, publish to
  // the relays (re-announcing our JOIN first so the relay membership gate
  // accepts the manifest even right after a relay restart), let it flush,
  // then apply locally.
  mesh?.broadcast({ t: "NS", records: [record] });
  await refreshJoin(true);
  const manifest = await createManifest(config.network_id, nodeKeys, {
    relays: config.relays,
    records: [record],
  });
  pool.publish(manifest);
  renderInvites();
  renderNs();
  toast(`招待 ${inviteId} を失効させました`, "ok");

  // give the P2P broadcast a moment to flush before we tear channels down,
  // then apply; re-publish once more so late reconnbers still catch it
  await new Promise((r) => setTimeout(r, 800));
  await applyRevocations();
  pool.publish(manifest);
}

interface IdentityExport {
  v: 1;
  config: NodeConfig;
  nodeKeys: StoredKeyPair;
  genesisKeys?: StoredKeyPair;
  inviteChain: InviteCertificate[];
  issuedInvites: IssuedInvite[];
}

async function exportIdentity(): Promise<void> {
  if (!config || !nodeStoredKeys) throw new Error("not joined");
  const payload: IdentityExport = {
    v: 1,
    config,
    nodeKeys: nodeStoredKeys,
    genesisKeys: await store.get<StoredKeyPair>("kv", "genesisKeys"),
    inviteChain,
    issuedInvites,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `anp-identity-${config.network_id.slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("identity をエクスポートしました (秘密鍵を含みます — 取り扱い注意)", "info");
}

async function importIdentity(text: string): Promise<void> {
  const payload = JSON.parse(text) as IdentityExport;
  if (payload.v !== 1 || !payload.config?.network_id || !payload.nodeKeys?.privateJwk) {
    throw new Error("identity ファイルの形式が不正です");
  }
  await store.put("kv", "config", payload.config);
  await store.put("kv", "nodeKeys", payload.nodeKeys);
  if (payload.genesisKeys) await store.put("kv", "genesisKeys", payload.genesisKeys);
  await store.put("kv", "inviteChain", payload.inviteChain ?? []);
  await store.put("kv", "issuedInvites", payload.issuedInvites ?? []);
  toast("identity をインポートしました", "ok");
  location.reload();
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------

let nodeStarted = false;

async function startNode(): Promise<void> {
  if (!config || !nodeKeys || !nodeStoredKeys) return;
  if (nodeStarted) return; // re-entry guard: never run two node runtimes
  nodeStarted = true;
  myNodeId = await nodeIdFromPubkey(nodeKeys.publicKeyHex);
  const ecdhKey = await importPrivateKeyForEcdh(nodeStoredKeys.privateJwk);

  const chainCheck = await verifyInviteChain(config.network_id, inviteChain, nodeKeys.publicKeyHex);
  myRights = chainCheck.ok ? chainCheck.rights : [];
  if (!chainCheck.ok && !genesisKeys) {
    log(`warning: local invite chain invalid (${chainCheck.reason})`);
    toast(`招待チェーンが無効です: ${chainCheck.reason}`, "error");
  }

  // per-log-instance epoch: keeps entry ids unique even if this identity is
  // restored elsewhere or the local seq counter is lost (see crdt.ts)
  let epoch = await store.get<string>("kv", "epoch");
  if (!epoch) {
    epoch = randomHex(4);
    await store.put("kv", "epoch", epoch);
  }
  const replica = `${myNodeId}.${epoch}`;
  chatLog = GSetLog.fromJSON(replica, (await store.get<LogEntry[]>("crdt", "chat")) ?? []);
  profileMap = LwwMap.fromJSON(replica, (await store.get<Record<string, LwwCell>>("crdt", "profile")) ?? {});
  nameService = new NameServiceStore(config.network_id);
  nameService.load(await store.all<NameRecord>("ns"));
  for (const member of await store.all<MemberRecord>("members")) {
    members.set(member.node_id, member);
  }
  revocations = nameService.revocations();

  // publish own (signed) nickname cell
  const nickKey = `nickname/${myNodeId}`;
  if (profileMap.get(nickKey) !== config.nickname) {
    const cell = profileMap.set(nickKey, config.nickname);
    await signCell(nodeKeys.privateKey, nodeKeys.publicKeyHex, nickKey, cell);
    await persistProfile();
  }

  mesh = new Mesh(config.network_id, nodeKeys, ecdhKey, myNodeId, {
    publishEvent: (event) => pool?.publish(event),
    onPeerOpen: (peer) => {
      sendHello(peer.node_id);
      if (chatLog && profileMap) {
        mesh?.send(peer.node_id, {
          t: "SYNC_REQ",
          chat_vv: chatLog.versionVector(),
          profile_lamport: 0,
        });
      }
      renderPeers();
    },
    onPeerClose: () => renderPeers(),
    onMessage: (from, msg) => void handleDcMessage(from, msg),
    log,
  });
  files = new FileService(store, mesh, log);

  pool = new RelayPool({
    urls: config.relays,
    filter: { network_id: config.network_id, target: myNodeId },
    onEvent: (event) => void handleRelayEvent(event),
    onStatus: (url, connected) => {
      renderRelays();
      if (connected) void announce();
    },
  });
  pool.start();

  timers.push(
    window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL * 1000),
    window.setInterval(() => void refreshJoin(), 240_000),
    window.setInterval(() => {
      mesh?.prune(nowSeconds(), HEARTBEAT_TTL * 2);
      renderPeers();
    }, 20_000),
    window.setInterval(() => void publishManifest(), 5 * 60_000),
    window.setInterval(() => renderRelays(), 5_000),
    // periodic anti-entropy: exchange deltas with one random connected peer,
    // healing any divergence that one-shot open-time syncs missed
    window.setInterval(() => {
      if (!mesh || !chatLog) return;
      const peers = mesh.connectedNodeIds();
      if (peers.length === 0) return;
      const peer = peers[Math.floor(Math.random() * peers.length)]!;
      mesh.send(peer, { t: "SYNC_REQ", chat_vv: chatLog.versionVector(), profile_lamport: 0 });
    }, ANTI_ENTROPY_MS),
  );

  latestLeave = await createLeave(config.network_id, nodeKeys);
  showMain();
  renderAll();
  log(`node started: ${short(myNodeId)} on ${anpUrl(config.network_id)} (proto v2)`);
}

let announced = false;

/** Publish (or re-publish) our JOIN; mining PoW happens off the UI thread's hot path. */
async function refreshJoin(force = false): Promise<void> {
  if (!config || !nodeKeys || !pool) return;
  const now = nowSeconds();
  if (!force && cachedJoin && cachedJoin.expires_at - now > JOIN_TTL / 3) {
    pool.publish(cachedJoin);
    return;
  }
  cachedJoin = await createJoin(config.network_id, nodeKeys, inviteChain, config.nickname);
  pool.publish(cachedJoin);
}

async function announce(): Promise<void> {
  await refreshJoin();
  // Re-publish the manifest on every (re)connect, not just the first time.
  // After a relay restart the relay's store is empty, so re-announcing our
  // JOIN and manifest re-seeds discovery and re-propagates any revocations we
  // know about. refreshJoin() ran first, so the membership gate accepts it.
  announced = true;
  await publishManifest();
}

async function heartbeat(): Promise<void> {
  if (!config || !nodeKeys || !pool) return;
  pool.publish(await createHeartbeat(config.network_id, nodeKeys));
  // keep a fresh pre-signed LEAVE around for sendBeacon on page close
  latestLeave = await createLeave(config.network_id, nodeKeys);
}

async function publishManifest(): Promise<void> {
  if (!config || !nodeKeys || !pool || !nameService) return;
  const existing = nameService.resolve(`node/${myNodeId}`);
  const record = await createNameRecord(
    config.network_id,
    nodeKeys,
    `node/${myNodeId}`,
    { kind: "node", nickname: config.nickname, node_id: myNodeId },
    (existing?.version ?? 0) + 1,
    600,
  );
  await nameService.merge(record);
  if (config.is_genesis) {
    const boot = nameService.resolve("bootstrap");
    const bootRecord = await createNameRecord(
      config.network_id,
      nodeKeys,
      "bootstrap",
      { kind: "relay-set", relays: config.relays },
      (boot?.version ?? 0) + 1,
      3600,
    );
    await nameService.merge(bootRecord);
  }
  await persistNs();
  pool.publish(
    await createManifest(config.network_id, nodeKeys, {
      relays: config.relays,
      records: nameService.all(),
    }),
  );
  renderNs();
}

async function handleRelayEvent(event: AnpEvent): Promise<void> {
  if (!mesh || !nameService) return;

  if (event.type === "JOIN" && event.node_id !== myNodeId) {
    // relayclient verified signature/chain; additionally enforce revocations
    const join = event as JoinEvent;
    const check = await verifyMembership(event.pubkey, join.body.invite_chain);
    if (!check.ok) {
      log(`JOIN from ${short(event.node_id)} rejected: ${check.reason}`);
      return;
    }
    await registerMember(event.node_id, event.pubkey, join.body.invite_chain, join.body.nickname, check.rights);
  }

  await mesh.handleDiscoveryEvent(event);

  if (event.type === "MANIFEST") {
    await mergeNsRecords(event.body.records ?? []);
  }
  if (event.type === "JOIN" || event.type === "HEARTBEAT" || event.type === "LEAVE") renderPeers();
}

// ---------------------------------------------------------------------------
// DataChannel sync
//
// DataChannels are implicitly authenticated: the SDP that established them
// was ECIES-encrypted to the peer's node key, so only that key's holder can
// be on the other end. CRDT payloads are additionally signed per entry.
// ---------------------------------------------------------------------------

function sendHello(to: NodeId): void {
  if (!mesh || !nodeKeys || !config) return;
  mesh.send(to, {
    t: "HELLO",
    node_id: myNodeId,
    pubkey: nodeKeys.publicKeyHex,
    nickname: config.nickname,
    chain: inviteChain,
    peers: [...mesh.peers.values()],
  });
}

function requestProof(origin: NodeId, from: NodeId): void {
  const last = proofRequested.get(origin) ?? 0;
  if (Date.now() - last < 10_000) return;
  proofRequested.set(origin, Date.now());
  mesh?.send(from, { t: "MEMBER_REQ", node_id: origin });
}

/** Shape validation per entry kind — a malformed entry must never be able to
 * poison the persisted log or break rendering. */
function validEntryData(entry: LogEntry): boolean {
  if (entry.kind === "chat") {
    const data = entry.data as { text?: unknown };
    return typeof data?.text === "string" && data.text.length <= 4096;
  }
  if (entry.kind === "file") {
    const meta = entry.data as Partial<FileMeta>;
    return (
      typeof meta?.cid === "string" &&
      /^cid:sha256:[0-9a-f]{64}$/.test(meta.cid) &&
      typeof meta.name === "string" &&
      meta.name.length <= 256 &&
      typeof meta.size === "number" &&
      meta.size >= 0
    );
  }
  return true;
}

async function acceptChatEntries(from: NodeId, entries: LogEntry[]): Promise<void> {
  if (!chatLog || !mesh) return;
  const mergeable: LogEntry[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry?.id !== "string") continue;
    if (!validEntryData(entry)) continue; // malformed shape
    if (!(await verifyLogEntry(entry))) continue; // forged or unsigned
    const originNode = replicaNodeId(entry.origin);
    if (originNode === myNodeId || members.has(originNode)) {
      mergeable.push(entry);
    } else {
      // hold until the origin's membership is proven
      let pending = pendingEntries.get(originNode);
      if (!pending) {
        pending = { entries: [], since: Date.now() };
        pendingEntries.set(originNode, pending);
      }
      let total = 0;
      for (const p of pendingEntries.values()) total += p.entries.length;
      if (total < MAX_PENDING) pending.entries.push(entry);
      requestProof(originNode, from);
    }
  }
  const added = chatLog.merge(mergeable);
  if (added.length) {
    await persistChat();
    renderChat();
    // gossip: forward what was new to us to every other peer, so entries
    // still propagate across partial meshes (A—hub—C without an A—C link)
    mesh.broadcast({ t: "CHAT_DELTA", entries: added }, from);
  }
}

async function handleDcMessage(from: NodeId, msg: DcMessage): Promise<void> {
  if (!mesh || !chatLog || !profileMap || !nameService || !files) return;

  if (await files.handleMessage(from, msg)) return;

  switch (msg.t) {
    case "HELLO": {
      if (msg.node_id !== from) return;
      const check = await verifyMembership(msg.pubkey, msg.chain ?? []);
      if (check.ok && (await nodeIdFromPubkey(msg.pubkey)) === from) {
        await registerMember(from, msg.pubkey, msg.chain ?? [], msg.nickname, check.rights);
        const peer = mesh.peers.get(from);
        if (peer) {
          peer.nickname = msg.nickname ?? peer.nickname;
          peer.rights = check.rights;
        }
      }
      // peer-table gossip: ask for proofs of members we haven't verified
      let asked = 0;
      for (const info of msg.peers ?? []) {
        if (
          asked < 20 &&
          info?.node_id &&
          info.node_id !== myNodeId &&
          !members.has(info.node_id) &&
          !mesh.peers.has(info.node_id)
        ) {
          requestProof(info.node_id, from);
          asked++;
        }
      }
      renderPeers();
      break;
    }
    case "MEMBER_REQ": {
      if (msg.node_id === myNodeId && nodeKeys && config) {
        mesh.send(from, {
          t: "MEMBER_PROOF",
          node_id: myNodeId,
          pubkey: nodeKeys.publicKeyHex,
          nickname: config.nickname,
          chain: inviteChain,
        });
      } else {
        const member = members.get(msg.node_id);
        if (member) {
          mesh.send(from, {
            t: "MEMBER_PROOF",
            node_id: member.node_id,
            pubkey: member.pubkey,
            nickname: member.nickname,
            chain: member.invite_chain,
          });
        }
      }
      break;
    }
    case "MEMBER_PROOF": {
      if ((await nodeIdFromPubkey(msg.pubkey)) !== msg.node_id) return;
      const live = await verifyMembership(msg.pubkey, msg.chain ?? []);
      if (live.ok) {
        await registerMember(msg.node_id, msg.pubkey, msg.chain ?? [], msg.nickname, live.rights);
        // make gossiped members visible as connectable peers
        if (msg.node_id !== myNodeId && !mesh.peers.has(msg.node_id)) {
          mesh.peers.set(msg.node_id, {
            node_id: msg.node_id,
            pubkey: msg.pubkey,
            nickname: msg.nickname,
            last_seen: nowSeconds(),
            rights: live.rights,
          });
        }
        renderPeers();
        break;
      }
      // fall back to history-only membership (cert expired but not revoked):
      // authenticates their past chat entries without granting live standing
      const historical = await verifyMembership(msg.pubkey, msg.chain ?? [], true);
      if (historical.ok) {
        await registerMember(msg.node_id, msg.pubkey, msg.chain ?? [], msg.nickname, [], true);
      }
      break;
    }
    case "SYNC_REQ": {
      mesh.send(from, { t: "CHAT_DELTA", entries: chatLog.entriesMissingFrom(msg.chat_vv ?? {}) });
      // profile deltas use a plain lamport watermark; requesters always send 0
      // (full resend) because the cell set is tiny — unlike chat, no VV needed
      mesh.send(from, { t: "PROFILE_DELTA", cells: profileMap.changedSince(msg.profile_lamport ?? 0) });
      mesh.send(from, { t: "NS", records: nameService.all() });
      break;
    }
    case "CHAT_DELTA": {
      await acceptChatEntries(from, msg.entries ?? []);
      break;
    }
    case "PROFILE_DELTA": {
      const verified: Record<string, LwwCell> = {};
      for (const [key, cell] of Object.entries(msg.cells ?? {})) {
        if (await verifyCell(key, cell)) verified[key] = cell;
      }
      const changed = profileMap.merge(verified);
      if (changed.length) {
        await persistProfile();
        renderPeers();
        renderChat();
        // gossip changed cells onward for partial meshes
        const forward: Record<string, LwwCell> = {};
        for (const key of changed) {
          const cell = profileMap.getCell(key);
          if (cell) forward[key] = cell;
        }
        mesh.broadcast({ t: "PROFILE_DELTA", cells: forward }, from);
      }
      break;
    }
    case "NS": {
      await mergeNsRecords(msg.records ?? [], from);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Chat + files
// ---------------------------------------------------------------------------

async function appendSignedEntry(kind: string, data: unknown): Promise<LogEntry | undefined> {
  if (!chatLog || !mesh || !nodeKeys) return undefined;
  const entry = chatLog.append(kind, data, nowSeconds());
  await signLogEntry(nodeKeys.privateKey, nodeKeys.publicKeyHex, entry);
  await persistChat();
  mesh.broadcast({ t: "CHAT_DELTA", entries: [entry] });
  renderChat();
  return entry;
}

async function sendChat(text: string): Promise<void> {
  if (!myRights.includes("chat")) {
    toast("このノードには chat 権限がありません", "error");
    return;
  }
  await appendSignedEntry("chat", { text });
}

async function shareFile(file: File): Promise<void> {
  if (!files) return;
  if (!myRights.includes("store")) {
    toast("このノードには store 権限がありません", "error");
    return;
  }
  const meta = await files.shareFile(file);
  await appendSignedEntry("file", meta);
  toast(`${file.name} を共有しました`, "ok");
}

const downloading = new Set<string>();

async function downloadFile(meta: FileMeta): Promise<void> {
  if (!files || downloading.has(meta.cid)) return;
  downloading.add(meta.cid);
  renderChat();
  try {
    const bytes = await files.fetchBlob(meta.cid);
    const blob = new Blob([bytes as BlobPart], { type: meta.mime || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = meta.name || "file";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${meta.name} を取得しました (CID検証済み)`, "ok");
  } catch (err) {
    toast(`取得失敗: ${(err as Error).message}`, "error");
  } finally {
    downloading.delete(meta.cid);
    renderChat();
  }
}

async function publishRecord(name: string, valueText: string): Promise<void> {
  if (!config || !nodeKeys || !nameService || !mesh || !pool) return;
  if (!myRights.includes("store")) throw new Error("このノードには store 権限がありません");
  let value: unknown;
  try {
    value = JSON.parse(valueText);
  } catch {
    // looks like intended JSON but doesn't parse — surface the mistake
    if (/^\s*[[{]/.test(valueText)) throw new Error("value の JSON が不正です");
    value = valueText;
  }
  const existing = nameService.resolve(name);
  const record = await createNameRecord(
    config.network_id,
    nodeKeys,
    name,
    value,
    (existing?.version ?? 0) + 1,
  );
  await nameService.merge(record);
  await persistNs();
  mesh.broadcast({ t: "NS", records: [record] });
  pool.publish(
    await createManifest(config.network_id, nodeKeys, { relays: config.relays, records: [record] }),
  );
  renderNs();
}

// ---------------------------------------------------------------------------
// Leave / reset
// ---------------------------------------------------------------------------

async function leaveNetwork(): Promise<void> {
  if (config && nodeKeys && pool) {
    pool.publish(await createLeave(config.network_id, nodeKeys));
  }
  mesh?.shutdown();
  pool?.stop();
  for (const t of timers) clearInterval(t);
  timers = [];
  log("left network (identity kept — reload to rejoin)");
  // don't leave a zombie UI behind: disable inputs, offer a rejoin control
  ($("chat-input") as HTMLInputElement).disabled = true;
  ($("btn-send") as HTMLButtonElement).disabled = true;
  ($("btn-file") as HTMLButtonElement).disabled = true;
  const leaveBtn = $("btn-leave") as HTMLButtonElement;
  leaveBtn.textContent = "再参加 (リロード)";
  leaveBtn.onclick = () => location.reload();
  toast("LEAVE を送信して切断しました", "info");
}

let beaconSent = false;
function sendLeaveBeacon(): void {
  if (beaconSent || !config || !latestLeave) return;
  beaconSent = true;
  const body = JSON.stringify(latestLeave);
  for (const relay of config.relays) {
    try {
      navigator.sendBeacon(`${relayHttpUrl(relay)}/event`, new Blob([body], { type: "application/json" }));
    } catch {
      /* best effort */
    }
  }
}

async function resetIdentity(): Promise<void> {
  await leaveNetwork();
  await store.clearAll();
  location.reload();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showMain(): void {
  $("setup").hidden = true;
  $("main").hidden = false;
}

function renderAll(): void {
  renderIdentity();
  renderRelays();
  renderPeers();
  renderChat();
  renderNs();
  renderInvites();
}

function renderIdentity(): void {
  if (!config) return;
  $("net-url").textContent = anpUrl(config.network_id);
  $("net-node-id").textContent = myNodeId;
  $("net-nickname").textContent = config.nickname;
  $("net-rights").textContent = myRights.join(", ") || "(なし)";
  $("net-role").textContent = config.is_genesis ? "creator (genesis 保持)" : "member";
  $("invite-card").hidden = !(genesisKeys || myRights.includes("invite"));
}

function renderRelays(): void {
  if (!pool) return;
  const now = nowSeconds();
  const parts = pool.statsSnapshot().map((s) => {
    const age = s.lastEventAt ? `${now - s.lastEventAt}s前` : "—";
    const err = s.lastError ? ` <span class="ng-text">${escapeHtml(s.lastError)}</span>` : "";
    return `<li><span class="dot ${s.connected ? "ok" : "ng"}"></span>${escapeHtml(s.url)}
      <span class="muted small">受信 ${s.eventsReceived} / 最終 ${age}${err}</span></li>`;
  });
  $("relay-list").innerHTML = parts.join("");
}

function nicknameOf(nodeId: NodeId): string {
  const nick = profileMap?.get(`nickname/${nodeId}`);
  if (typeof nick === "string" && nick) return nick;
  const member = members.get(nodeId);
  if (member?.nickname) return member.nickname;
  return mesh?.peers.get(nodeId)?.nickname ?? short(nodeId);
}

function renderPeers(): void {
  if (!mesh) return;
  const connected = new Set(mesh.connectedNodeIds());
  const now = nowSeconds();
  const rows = [...mesh.peers.values()]
    .sort((a, b) => a.node_id.localeCompare(b.node_id))
    .map((peer) => {
      const state = connected.has(peer.node_id)
        ? `<span class="dot ok"></span>P2P接続中`
        : now - peer.last_seen <= HEARTBEAT_TTL * 2
          ? `<span class="dot warn"></span>発見済み`
          : `<span class="dot ng"></span>応答なし`;
      const verified = members.has(peer.node_id)
        ? `<span class="badge ok-badge">検証済み</span>`
        : `<span class="badge">未検証</span>`;
      return `<li><b>${escapeHtml(nicknameOf(peer.node_id))}</b> <code>${short(peer.node_id)}</code> ${state} ${verified}</li>`;
    });
  $("peer-list").innerHTML = rows.join("") || `<li class="muted">他の参加者はまだいません</li>`;
  $("peer-count").textContent = String(connected.size);
}

function renderChat(): void {
  if (!chatLog) return;
  const rows = chatLog
    .ordered()
    .filter((entry) => entry.kind === "chat" || entry.kind === "file")
    .map((entry) => {
      const originNode = replicaNodeId(entry.origin);
      const mine = originNode === myNodeId;
      const time = new Date(entry.ts * 1000).toLocaleTimeString();
      const who = escapeHtml(nicknameOf(originNode));
      if (entry.kind === "file") {
        // defensive: a malformed persisted entry must not break rendering
        const meta = (entry.data ?? {}) as Partial<FileMeta>;
        const cid = escapeHtml(String(meta.cid ?? ""));
        const busy = downloading.has(String(meta.cid));
        return `<div class="msg ${mine ? "mine" : ""}">
          <span class="who">${who}</span>
          <span class="file-chip" data-cid="${cid}">
            📄 ${escapeHtml(String(meta.name ?? "file"))} <span class="muted">(${humanSize(Number(meta.size) || 0)})</span>
            <button class="mini file-dl" data-cid="${cid}" ${busy ? "disabled" : ""}>
              ${busy ? "取得中…" : "取得"}
            </button>
          </span>
          <span class="time">${time}</span></div>`;
      }
      const data = entry.data as { text?: string };
      return `<div class="msg ${mine ? "mine" : ""}"><span class="who">${who}</span><span class="text">${escapeHtml(
        String(data?.text ?? ""),
      )}</span><span class="time">${time}</span></div>`;
    });
  const box = $("chat-box");
  // only auto-scroll when the user was already reading the newest messages
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 48;
  box.innerHTML = rows.join("") || `<div class="muted">まだメッセージはありません</div>`;
  for (const btn of box.querySelectorAll<HTMLButtonElement>(".file-dl")) {
    btn.onclick = () => {
      const cid = btn.dataset["cid"]!;
      const entry = chatLog!.ordered().find((e) => e.kind === "file" && (e.data as FileMeta).cid === cid);
      if (entry) void downloadFile(entry.data as FileMeta);
    };
  }
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

function renderNs(): void {
  if (!nameService) return;
  const rows = nameService.all().map(
    (record) => `
      <tr>
        <td><code>${escapeHtml(record.name)}</code></td>
        <td><code>${escapeHtml(JSON.stringify(record.value))}</code></td>
        <td>${record.version}</td>
        <td>${record.ttl}s</td>
        <td><code>${short(record.author_pubkey)}</code></td>
      </tr>`,
  );
  $("ns-body").innerHTML =
    rows.join("") || `<tr><td colspan="5" class="muted">レコードはまだありません</td></tr>`;
}

function renderInvites(): void {
  const list = $("issued-list");
  if (issuedInvites.length === 0) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = issuedInvites
    .map((inv) => {
      const state = inv.revoked
        ? `<span class="badge">失効済み</span>`
        : `<button class="mini danger revoke-btn" data-id="${escapeHtml(inv.invite_id)}">失効</button>`;
      return `<li><code>${escapeHtml(inv.invite_id)}</code>
        <span class="muted small">→ ${short(inv.subject_pubkey)} [${inv.rights.join(",")}]</span> ${state}</li>`;
    })
    .join("");
  for (const btn of list.querySelectorAll<HTMLButtonElement>(".revoke-btn")) {
    btn.onclick = () => {
      if (confirm(`招待 ${btn.dataset["id"]} を失効させますか?\n(この招待で参加した全ノードが切断されます)`)) {
        void revokeInvite(btn.dataset["id"]!).catch((err) => toast((err as Error).message, "error"));
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Boot + UI wiring
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await store.get<NodeConfig>("kv", "config");
  if (!config) {
    $("setup").hidden = false;
    $("main").hidden = true;
    applyInviteHash();
    return;
  }
  if (/#invite=/.test(location.hash)) {
    toast("このブラウザは既にネットワークに参加済みのため、招待リンクは使えません。別プロファイルで開くか identity を削除してください", "info");
    history.replaceState(null, "", location.pathname);
  }
  nodeStoredKeys = await store.get<StoredKeyPair>("kv", "nodeKeys");
  if (!nodeStoredKeys) {
    $("setup").hidden = false;
    return;
  }
  nodeKeys = await importKeyPair(nodeStoredKeys);
  const storedGenesis = await store.get<StoredKeyPair>("kv", "genesisKeys");
  genesisKeys = storedGenesis ? await importKeyPair(storedGenesis) : undefined;
  inviteChain = (await store.get<InviteCertificate[]>("kv", "inviteChain")) ?? [];
  issuedInvites = (await store.get<IssuedInvite[]>("kv", "issuedInvites")) ?? [];
  await startNode();
}

/** #invite=… in the URL prefills the join form (invite links). */
function applyInviteHash(): void {
  const match = /#invite=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!match) return;
  ($("join-bundle") as HTMLTextAreaElement).value = match[1]!;
  $("join-card").scrollIntoView({ behavior: "smooth" });
  void store.get<StoredKeyPair>("kv", "pendingKeys").then((pending) => {
    if (pending) {
      toast("招待リンクを検出しました。ニックネームを入れて参加してください", "info");
    } else {
      toast(
        "招待リンクを検出しました。この招待があなたの参加リクエストコード宛でない場合は参加できません — 先に手順1でコードを作り、招待者に渡してください",
        "info",
      );
    }
  });
}

function busyWrap(btn: HTMLButtonElement, fn: () => Promise<void>): void {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message, "error");
      log(`error: ${(err as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  };
}

function wireUi(): void {
  busyWrap($("btn-create") as HTMLButtonElement, async () => {
    const nickname = ($("create-nickname") as HTMLInputElement).value.trim() || "creator";
    const relays = ($("create-relays") as HTMLTextAreaElement).value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await createNetwork(nickname, relays.length ? relays : defaultRelays());
  });

  busyWrap($("btn-request") as HTMLButtonElement, async () => {
    const code = await prepareJoinRequest();
    const out = $("request-code") as HTMLTextAreaElement;
    out.value = code;
    out.hidden = false;
    $("request-hint").hidden = false;
  });

  busyWrap($("btn-join") as HTMLButtonElement, async () => {
    const bundle = ($("join-bundle") as HTMLTextAreaElement).value;
    const nickname = ($("join-nickname") as HTMLInputElement).value.trim() || "member";
    await acceptInvite(bundle, nickname);
  });

  busyWrap($("btn-import") as HTMLButtonElement, async () => {
    const text = ($("import-json") as HTMLTextAreaElement).value.trim();
    if (!text) throw new Error("identity JSON を貼り付けてください");
    await importIdentity(text);
  });

  $("btn-copy-url").onclick = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(anpUrl(config.network_id));
      toast("URLをコピーしました", "ok");
    } catch {
      toast("コピーできませんでした (手動で選択してください)", "error");
    }
  };

  busyWrap($("btn-issue") as HTMLButtonElement, async () => {
    const pubkey = ($("invite-pubkey") as HTMLInputElement).value.trim();
    const grantInvite = ($("invite-grant") as HTMLInputElement).checked;
    const { bundle, link } = await issueInvite(pubkey, grantInvite);
    const out = $("invite-bundle") as HTMLTextAreaElement;
    out.value = bundle;
    out.hidden = false;
    const linkRow = $("invite-link-row");
    linkRow.hidden = !link;
    if (link) ($("invite-link") as HTMLInputElement).value = link;
    toast("招待バンドルを発行しました", "ok");
  });

  $("btn-copy-invite-link").onclick = async () => {
    const link = ($("invite-link") as HTMLInputElement).value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("招待リンクをコピーしました", "ok");
    } catch {
      toast("コピーできませんでした (手動で選択してください)", "error");
    }
  };

  const chatInput = $("chat-input") as HTMLInputElement;
  $("btn-send").onclick = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    void sendChat(text);
  };
  chatInput.onkeydown = (ev) => {
    // never send while the IME is composing (Japanese input Enter = confirm)
    if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) {
      ($("btn-send") as HTMLButtonElement).click();
    }
  };

  const fileInput = $("file-input") as HTMLInputElement;
  $("btn-file").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void shareFile(file).catch((err) => toast((err as Error).message, "error"));
  };

  busyWrap($("btn-ns-publish") as HTMLButtonElement, async () => {
    const name = ($("ns-name") as HTMLInputElement).value.trim();
    const value = ($("ns-value") as HTMLInputElement).value.trim();
    if (!name) return;
    await publishRecord(name, value);
    toast(`${name} を公開しました`, "ok");
  });

  busyWrap($("btn-export") as HTMLButtonElement, () => exportIdentity());
  $("btn-leave").onclick = () => void leaveNetwork();
  $("btn-reset").onclick = () => {
    if (confirm("鍵・履歴・ネットワーク設定をすべて削除します。よろしいですか?")) void resetIdentity();
  };

  // best-effort LEAVE on tab close; heartbeat TTL covers the rest
  window.addEventListener("pagehide", sendLeaveBeacon);
  window.addEventListener("beforeunload", sendLeaveBeacon);
  window.addEventListener("hashchange", () => {
    if (!config) applyInviteHash();
  });
}

/** Fatal, user-visible startup failure (never a silent blank page). */
function fatal(message: string): void {
  document.body.innerHTML = `
    <div class="card" style="margin-top:15vh">
      <h2>起動できません</h2>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

/**
 * Enforce a single active tab per browser profile. Two tabs would run the
 * same node identity (same keys, same CRDT epoch) concurrently and corrupt
 * the log with colliding entry ids. Uses the Web Locks API; the lock is held
 * until the tab closes.
 */
function acquireSingleTabLock(): Promise<boolean> {
  if (!("locks" in navigator)) return Promise.resolve(true); // very old browser: best effort
  return new Promise((resolve) => {
    void navigator.locks.request("anp-node", { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock) await new Promise(() => {}); // hold forever (released on tab close)
    });
  });
}

void (async () => {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
    fatal(
      "このアプリには Web Crypto と IndexedDB が必要です。HTTPS または localhost (secure context) で開いてください。",
    );
    return;
  }
  if (!(await acquireSingleTabLock())) {
    fatal(
      "ANP は既に別のタブで実行中です。同じ identity を2つ同時に動かすとデータが壊れるため、このタブでは起動しません。別ノードを試すには別のブラウザプロファイルを使ってください。",
    );
    return;
  }
  try {
    store = await AnpStore.open();
    wireUi();
    await boot();
  } catch (err) {
    fatal(`初期化に失敗しました: ${(err as Error).message}`);
  }
})();
