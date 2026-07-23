/**
 * ANP browser node — application wiring.
 *
 * Boot flow (design doc §8):
 *   creator:  genesis keys -> network id -> self-invite cert -> JOIN
 *   invitee:  node keys -> join request code -> invite bundle -> verify -> JOIN
 *
 * After JOIN the node subscribes on the relay pool, forms a WebRTC mesh with
 * every live peer, and synchronizes the chat CRDT, profile CRDT and the Name
 * Service record set over DataChannels.
 */

import {
  type KeyPairHandle,
  type StoredKeyPair,
  exportKeyPair,
  generateKeyPair,
  importKeyPair,
  nowSeconds,
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
  createHeartbeat,
  createJoin,
  createLeave,
  createManifest,
} from "../shared/events.js";
import { GSetLog, LwwMap, type LogEntry, type LwwCell } from "../shared/crdt.js";
import { NameServiceStore, createNameRecord } from "../shared/nameservice.js";
import type {
  AnpEvent,
  InviteBundle,
  InviteCertificate,
  NameRecord,
  PeerInfo,
  Right,
} from "../shared/types.js";
import { AnpStore } from "./store.js";
import { RelayPool } from "./relayclient.js";
import { Mesh, type DcMessage } from "./webrtc.js";

interface NodeConfig {
  network_id: string;
  relays: string[];
  nickname: string;
  is_genesis: boolean;
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

function defaultRelays(): string[] {
  if (location.protocol.startsWith("http")) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return [`${proto}//${location.host}`];
  }
  return ["ws://localhost:8787"];
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let store: AnpStore;
let config: NodeConfig | undefined;
let nodeKeys: KeyPairHandle | undefined;
let genesisKeys: KeyPairHandle | undefined;
let inviteChain: InviteCertificate[] = [];
let myRights: Right[] = [];
let myNodeId = "";

let pool: RelayPool | undefined;
let mesh: Mesh | undefined;
let chatLog: GSetLog | undefined;
let profileMap: LwwMap | undefined;
let nameService: NameServiceStore | undefined;
let timers: number[] = [];

const relayStatus = new Map<string, boolean>();

function log(line: string): void {
  const el = $("log");
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${line}\n${el.textContent ?? ""}`.slice(0, 20_000);
}

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
  log(`invite accepted for ${anpUrl(bundle.network_id)}`);
  await boot();
}

async function issueInvite(subjectPubkey: string, grantInvite: boolean): Promise<string> {
  if (!config || !nodeKeys) throw new Error("not joined");
  if (!/^[0-9a-f]{130}$/.test(subjectPubkey)) throw new Error("参加リクエストコードの形式が不正です");
  const rights: Right[] = grantInvite ? ["join", "invite", "chat", "store"] : ["join", "chat", "store"];
  let chain: InviteCertificate[];
  if (genesisKeys) {
    // creator: issue directly from the genesis key — shortest possible chain
    chain = [
      await issueCertificate({
        networkId: config.network_id,
        issuer: genesisKeys,
        subjectPubkey,
        rights,
      }),
    ];
  } else {
    if (!myRights.includes("invite")) throw new Error("このノードには招待権がありません");
    chain = [
      ...inviteChain,
      await issueCertificate({
        networkId: config.network_id,
        issuer: nodeKeys,
        subjectPubkey,
        rights,
      }),
    ];
  }
  const bundle: InviteBundle = {
    v: 1,
    network_id: config.network_id,
    genesis_pubkey: genesisKeys?.publicKeyHex ?? inviteChain[0]!.issuer_pubkey,
    relays: config.relays,
    chain,
  };
  return encodeInviteBundle(bundle);
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------

async function startNode(): Promise<void> {
  if (!config || !nodeKeys) return;
  myNodeId = await nodeIdFromPubkey(nodeKeys.publicKeyHex);
  const chainCheck = await verifyInviteChain(config.network_id, inviteChain, nodeKeys.publicKeyHex);
  myRights = chainCheck.ok ? chainCheck.rights : [];
  if (!chainCheck.ok && !genesisKeys) {
    log(`warning: local invite chain invalid (${chainCheck.reason})`);
  }

  chatLog = GSetLog.fromJSON(myNodeId, (await store.get<LogEntry[]>("crdt", "chat")) ?? []);
  profileMap = LwwMap.fromJSON(myNodeId, (await store.get<Record<string, LwwCell>>("crdt", "profile")) ?? {});
  nameService = new NameServiceStore(config.network_id);
  nameService.load(await store.all<NameRecord>("ns"));
  profileMap.set(`nickname/${myNodeId}`, config.nickname);

  mesh = new Mesh(config.network_id, nodeKeys, myNodeId, {
    publishEvent: (event) => pool?.publish(event),
    onPeerOpen: (peer) => {
      sendHello(peer.node_id);
      mesh?.send(peer.node_id, {
        t: "SYNC_REQ",
        chat_lamport: 0,
        profile_lamport: 0,
      });
      renderPeers();
    },
    onPeerClose: () => renderPeers(),
    onMessage: (from, msg) => void handleDcMessage(from, msg),
    log,
  });

  pool = new RelayPool({
    urls: config.relays,
    filter: { network_id: config.network_id, target: myNodeId },
    onEvent: (event) => void handleRelayEvent(event),
    onStatus: (url, connected) => {
      relayStatus.set(url, connected);
      renderRelays();
      if (connected) void announce();
    },
  });
  pool.start();

  timers.push(
    window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL * 1000),
    window.setInterval(() => {
      mesh?.prune(nowSeconds(), HEARTBEAT_TTL);
      renderPeers();
    }, 20_000),
    window.setInterval(() => void publishManifest(), 5 * 60_000),
  );

  showMain();
  renderAll();
  log(`node started: ${short(myNodeId)} on ${anpUrl(config.network_id)}`);
}

let announced = false;
async function announce(): Promise<void> {
  if (!config || !nodeKeys || !pool) return;
  pool.publish(await createJoin(config.network_id, nodeKeys, inviteChain, config.nickname));
  if (!announced) {
    announced = true;
    await publishManifest();
  }
}

async function heartbeat(): Promise<void> {
  if (!config || !nodeKeys || !pool) return;
  pool.publish(await createHeartbeat(config.network_id, nodeKeys));
}

async function publishManifest(): Promise<void> {
  if (!config || !nodeKeys || !pool || !nameService) return;
  // presence record for the name service: node/<id> -> reachable node
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
  await mesh.handleDiscoveryEvent(event);
  if (event.type === "MANIFEST") {
    let changed = false;
    for (const record of event.body.records ?? []) {
      if (await nameService.merge(record)) changed = true;
    }
    if (changed) {
      await persistNs();
      renderNs();
    }
  }
  if (event.type === "JOIN" || event.type === "HEARTBEAT" || event.type === "LEAVE") renderPeers();
}

// ---------------------------------------------------------------------------
// DataChannel sync
// ---------------------------------------------------------------------------

function sendHello(to: string): void {
  if (!mesh || !nodeKeys || !config) return;
  mesh.send(to, {
    t: "HELLO",
    node_id: myNodeId,
    pubkey: nodeKeys.publicKeyHex,
    nickname: config.nickname,
    peers: [...mesh.peers.values()],
  });
}

async function handleDcMessage(from: string, msg: DcMessage): Promise<void> {
  if (!mesh || !chatLog || !profileMap || !nameService) return;
  switch (msg.t) {
    case "HELLO": {
      const peer = mesh.peers.get(from);
      if (peer && msg.nickname) peer.nickname = msg.nickname;
      // peer-table gossip: learn about members we haven't seen on the relay
      for (const info of msg.peers ?? []) {
        if (info.node_id !== myNodeId && !mesh.peers.has(info.node_id)) {
          mesh.peers.set(info.node_id, info);
        }
      }
      renderPeers();
      break;
    }
    case "SYNC_REQ": {
      mesh.send(from, { t: "CHAT_DELTA", entries: chatLog.entriesSince(msg.chat_lamport) });
      mesh.send(from, { t: "PROFILE_DELTA", cells: profileMap.changedSince(msg.profile_lamport) });
      mesh.send(from, { t: "NS", records: nameService.all() });
      break;
    }
    case "CHAT_DELTA": {
      const added = chatLog.merge(msg.entries ?? []);
      if (added.length) {
        await persistChat();
        renderChat();
      }
      break;
    }
    case "PROFILE_DELTA": {
      const changed = profileMap.merge(msg.cells ?? {});
      if (changed.length) {
        await persistProfile();
        renderPeers();
        renderChat();
      }
      break;
    }
    case "NS": {
      let changed = false;
      for (const record of msg.records ?? []) {
        if (await nameService.merge(record)) changed = true;
      }
      if (changed) {
        await persistNs();
        renderNs();
      }
      break;
    }
  }
}

async function sendChat(text: string): Promise<void> {
  if (!chatLog || !mesh) return;
  if (!myRights.includes("chat")) {
    log("このノードには chat 権限がありません");
    return;
  }
  const entry = chatLog.append("chat", { text, author: myNodeId }, nowSeconds());
  await persistChat();
  mesh.broadcast({ t: "CHAT_DELTA", entries: [entry] });
  renderChat();
}

async function publishRecord(name: string, valueText: string): Promise<void> {
  if (!config || !nodeKeys || !nameService || !mesh || !pool) return;
  if (!myRights.includes("store")) throw new Error("このノードには store 権限がありません");
  let value: unknown;
  try {
    value = JSON.parse(valueText);
  } catch {
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

async function leaveNetwork(): Promise<void> {
  if (config && nodeKeys && pool) {
    pool.publish(await createLeave(config.network_id, nodeKeys));
  }
  mesh?.shutdown();
  pool?.stop();
  for (const t of timers) clearInterval(t);
  timers = [];
  log("left network (identity kept — reload to rejoin)");
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
}

function renderIdentity(): void {
  if (!config) return;
  $("net-url").textContent = anpUrl(config.network_id);
  $("net-node-id").textContent = myNodeId;
  $("net-nickname").textContent = config.nickname;
  $("net-rights").textContent = myRights.join(", ") || "(なし)";
  $("net-role").textContent = config.is_genesis ? "creator (genesis 保持)" : "member";
  ($("invite-card") as HTMLElement).hidden = !(genesisKeys || myRights.includes("invite"));
}

function renderRelays(): void {
  if (!config) return;
  const parts = config.relays.map((url) => {
    const ok = relayStatus.get(url);
    return `<li><span class="dot ${ok ? "ok" : "ng"}"></span>${escapeHtml(url)}</li>`;
  });
  $("relay-list").innerHTML = parts.join("");
}

function nicknameOf(nodeId: string): string {
  const nick = profileMap?.get(`nickname/${nodeId}`);
  if (typeof nick === "string" && nick) return nick;
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
        : now - peer.last_seen <= HEARTBEAT_TTL
          ? `<span class="dot warn"></span>発見済み`
          : `<span class="dot ng"></span>停止?`;
      return `<li><b>${escapeHtml(nicknameOf(peer.node_id))}</b> <code>${short(peer.node_id)}</code> ${state}</li>`;
    });
  $("peer-list").innerHTML = rows.join("") || `<li class="muted">他の参加者はまだいません</li>`;
  $("peer-count").textContent = String(connected.size);
}

function renderChat(): void {
  if (!chatLog) return;
  const rows = chatLog
    .ordered()
    .filter((entry) => entry.kind === "chat")
    .map((entry) => {
      const data = entry.data as { text?: string; author?: string };
      const mine = entry.origin === myNodeId;
      const time = new Date(entry.ts * 1000).toLocaleTimeString();
      return `<div class="msg ${mine ? "mine" : ""}"><span class="who">${escapeHtml(
        nicknameOf(data.author ?? entry.origin),
      )}</span><span class="text">${escapeHtml(String(data.text ?? ""))}</span><span class="time">${time}</span></div>`;
    });
  const box = $("chat-box");
  box.innerHTML = rows.join("") || `<div class="muted">まだメッセージはありません</div>`;
  box.scrollTop = box.scrollHeight;
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

// ---------------------------------------------------------------------------
// Boot + UI wiring
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await store.get<NodeConfig>("kv", "config");
  if (!config) {
    $("setup").hidden = false;
    $("main").hidden = true;
    return;
  }
  const storedNode = await store.get<StoredKeyPair>("kv", "nodeKeys");
  if (!storedNode) {
    $("setup").hidden = false;
    return;
  }
  nodeKeys = await importKeyPair(storedNode);
  const storedGenesis = await store.get<StoredKeyPair>("kv", "genesisKeys");
  genesisKeys = storedGenesis ? await importKeyPair(storedGenesis) : undefined;
  inviteChain = (await store.get<InviteCertificate[]>("kv", "inviteChain")) ?? [];
  await startNode();
}

function wireUi(): void {
  $("btn-create").onclick = async () => {
    try {
      const nickname = ($("create-nickname") as HTMLInputElement).value.trim() || "creator";
      const relays = ($("create-relays") as HTMLTextAreaElement).value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await createNetwork(nickname, relays.length ? relays : defaultRelays());
    } catch (err) {
      log(`create failed: ${(err as Error).message}`);
    }
  };

  $("btn-request").onclick = async () => {
    try {
      const code = await prepareJoinRequest();
      const out = $("request-code") as HTMLTextAreaElement;
      out.value = code;
      out.hidden = false;
      $("request-hint").hidden = false;
    } catch (err) {
      log(`request failed: ${(err as Error).message}`);
    }
  };

  $("btn-join").onclick = async () => {
    try {
      const bundle = ($("join-bundle") as HTMLTextAreaElement).value;
      const nickname = ($("join-nickname") as HTMLInputElement).value.trim() || "member";
      await acceptInvite(bundle, nickname);
    } catch (err) {
      alert((err as Error).message);
      log(`join failed: ${(err as Error).message}`);
    }
  };

  $("btn-copy-url").onclick = () => {
    if (config) void navigator.clipboard.writeText(anpUrl(config.network_id));
  };

  $("btn-issue").onclick = async () => {
    try {
      const pubkey = ($("invite-pubkey") as HTMLInputElement).value.trim();
      const grantInvite = ($("invite-grant") as HTMLInputElement).checked;
      const bundle = await issueInvite(pubkey, grantInvite);
      const out = $("invite-bundle") as HTMLTextAreaElement;
      out.value = bundle;
      out.hidden = false;
      log("invite bundle issued");
    } catch (err) {
      alert((err as Error).message);
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
    if (ev.key === "Enter") ($("btn-send") as HTMLButtonElement).click();
  };

  $("btn-ns-publish").onclick = async () => {
    try {
      const name = ($("ns-name") as HTMLInputElement).value.trim();
      const value = ($("ns-value") as HTMLInputElement).value.trim();
      if (!name) return;
      await publishRecord(name, value);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  $("btn-leave").onclick = () => void leaveNetwork();
  $("btn-reset").onclick = () => {
    if (confirm("鍵・履歴・ネットワーク設定をすべて削除します。よろしいですか?")) void resetIdentity();
  };

  window.addEventListener("beforeunload", () => {
    // best-effort LEAVE; heartbeat TTL covers the case where this doesn't send
    void leaveNetwork();
  });
}

void (async () => {
  store = await AnpStore.open();
  wireUi();
  await boot();
})();
