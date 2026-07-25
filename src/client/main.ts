/**
 * ANP Chat — orchestrator.
 *
 * One identity, many conversations. Each conversation (channel or DM) is an
 * independent ANP network handled by a `Conversation` (relay + WebRTC mesh +
 * chat CRDT). This module owns the identity, the shared relay list, the list
 * of open conversations, and the UI (a conversation sidebar + active chat).
 *
 * Default experience: pick a display name, land in #general, and browse or
 * create channels / start DMs from the sidebar — no room-name wall.
 */

import {
  type KeyPairHandle,
  type StoredKeyPair,
  exportKeyPair,
  generateKeyPair,
  importKeyPair,
  importPrivateKeyForEcdh,
} from "../shared/crypto.js";
import {
  dmNetworkId,
  dmRoom,
  nodeIdFromPubkey,
  normalizeRoom,
  openNetworkId,
} from "../shared/identity.js";
import { AnpStore } from "./store.js";
import { Reputation, type PeerScore } from "../shared/reputation.js";
import { Conversation, type ConvSpec, type Identity } from "./conversation.js";
import type { FileMeta } from "../shared/types.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let store: AnpStore;
let reputation = new Reputation();
let identity: Identity | undefined;
let nickname = "";
let relays: string[] = [];
const conversations = new Map<string, Conversation>();
let activeId: string | undefined;

interface ConvPersist {
  network_id: string;
  kind: "channel" | "dm";
  room: string;
  title: string;
  peerPubkey?: string;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (id: string) => (id ? `${id.slice(0, 10)}…` : "");
function humanSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}
const AVATAR_COLORS = ["#6d5efc", "#e0567a", "#20a4a4", "#e0952b", "#3b82f6", "#8b5cf6", "#16a34a", "#db2777"];
function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
function avatarHtml(id: string, name: string, cls = "avatar"): string {
  return `<span class="${cls}" style="background:${avatarColor(id)}">${escapeHtml(initial(name))}</span>`;
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
  const el = document.getElementById("log");
  if (!el) return;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}\n${el.textContent ?? ""}`.slice(0, 12000);
}
async function copy(text: string, okMsg: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "ok");
  } catch {
    toast("コピーできませんでした", "error");
  }
}
/** A relay URL provided in the page URL (?relay=… or #relay=…). Lets a hosted
 * frontend be pointed at any relay by sharing one link — handy on phones. */
function urlRelay(): string | undefined {
  const q = new URLSearchParams(location.search).get("relay");
  const h = /[#&]relay=([^&]+)/.exec(location.hash);
  const raw = q ?? (h ? decodeURIComponent(h[1]!) : undefined);
  return raw && /^wss?:\/\//.test(raw) ? raw : undefined;
}
function defaultRelays(): string[] {
  const fromUrl = urlRelay();
  if (fromUrl) return [fromUrl];
  if (location.protocol.startsWith("http")) {
    return [`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`];
  }
  return [];
}
function autoNickname(): string {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return `guest-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Conversation management
// ---------------------------------------------------------------------------

function deps() {
  return {
    store,
    reputation,
    nickname: () => nickname,
    onChange: (c: Conversation) => {
      if (c.networkId === activeId) void renderChat();
      renderConvList();
    },
    onActivity: (c: Conversation) => {
      if (c.networkId !== activeId) renderConvList();
    },
    log,
  };
}

async function persistConversations(): Promise<void> {
  const list: ConvPersist[] = [...conversations.values()]
    .filter((c) => c.kind !== "invite")
    .map((c) => ({
      network_id: c.networkId,
      kind: c.kind as "channel" | "dm",
      room: c.spec.room ?? "",
      title: c.spec.title,
      peerPubkey: c.spec.peerPubkey,
    }));
  await store.put("kv", "conversations", list);
}

async function addConversation(spec: ConvSpec, activate = true): Promise<Conversation> {
  let conv = conversations.get(spec.network_id);
  if (!conv) {
    conv = new Conversation(spec, identity!, deps());
    conversations.set(spec.network_id, conv);
    await conv.start();
    await persistConversations();
  }
  if (activate) setActive(spec.network_id);
  renderConvList();
  return conv;
}

async function openChannel(name: string): Promise<void> {
  const room = normalizeRoom(name);
  if (!room) throw new Error("チャンネル名を入力してください");
  const networkId = await openNetworkId(room);
  await addConversation({ network_id: networkId, kind: "channel", room, title: `#${room}`, relays });
}

async function openDm(peerPubkey: string): Promise<void> {
  const pk = peerPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{130}$/.test(pk)) throw new Error("ユーザーIDの形式が正しくありません");
  if (pk === identity!.pubkeyHex) throw new Error("自分自身とはDMできません");
  const networkId = await dmNetworkId(identity!.pubkeyHex, pk);
  const room = dmRoom(identity!.pubkeyHex, pk);
  await addConversation({
    network_id: networkId,
    kind: "dm",
    room,
    title: `@${short(pk)}`,
    relays,
    peerPubkey: pk,
  });
}

function setActive(networkId: string): void {
  activeId = networkId;
  conversations.get(networkId)?.clearUnread();
  document.body.classList.add("chat-open");
  $("chat").classList.remove("empty-state");
  $("chat-empty").hidden = true;
  $("chat-view").hidden = false;
  void renderChat();
  renderConvList();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderConvList(): void {
  const list = $("conv-list");
  const items = [...conversations.values()].sort((a, b) => b.lastTs - a.lastTs);
  list.innerHTML =
    items
      .map((c) => {
        const active = c.networkId === activeId;
        const unread = c.unread > 0 ? `<span class="unread">${c.unread}</span>` : "";
        const sub = c.connectedCount() > 0 ? `${c.connectedCount()}人接続中` : "探索中…";
        return `<button class="conv-item ${active ? "active" : ""}" data-id="${c.networkId}">
          ${avatarHtml(c.networkId, c.displayTitle().replace(/^[#@]/, ""))}
          <div class="conv-main"><div class="conv-title">${escapeHtml(c.displayTitle())}</div><div class="conv-sub">${sub}</div></div>
          ${unread}
        </button>`;
      })
      .join("") || `<div class="muted small" style="padding:16px">会話がありません</div>`;
  for (const btn of list.querySelectorAll<HTMLButtonElement>(".conv-item")) {
    btn.onclick = () => setActive(btn.dataset["id"]!);
  }
  // profile chip
  $("me-name").textContent = nickname;
  ($("me-avatar") as HTMLElement).style.background = avatarColor(identity?.myNodeId ?? "");
  $("me-avatar").textContent = initial(nickname);
}

async function renderChat(): Promise<void> {
  if (!activeId) return;
  const conv = conversations.get(activeId);
  if (!conv) return;
  $("room-title").textContent = conv.displayTitle();
  const dot = $("conn-dot");
  const ctext = $("conn-text");
  dot.className = "dot";
  const connected = conv.connectedCount();
  if (connected > 0) {
    dot.classList.add("ok");
    ctext.textContent = conv.kind === "dm" ? "接続中・暗号化" : `${connected}人と接続中`;
  } else if (conv.relaysUp() > 0) {
    dot.classList.add("warn");
    ctext.textContent = "相手を探索中…";
  } else if (!conv.hasRelays()) {
    dot.classList.add("ng");
    ctext.textContent = "Relay未設定";
  } else {
    dot.classList.add("ng");
    ctext.textContent = "Relayに接続中…";
  }

  const box = $("chat-box");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  const msgs = await conv.messages();
  box.innerHTML =
    msgs
      .map((m) => {
        const time = new Date(m.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const who = conv.nicknameOf(m.origin);
        let inner: string;
        if (m.kind === "file" && m.file) {
          const busy = downloading.has(m.file.cid);
          inner = `<span class="file-chip" data-cid="${escapeHtml(m.file.cid)}">📄
            <span class="fname">${escapeHtml(m.file.name)}</span>
            <span class="muted">${humanSize(m.file.size)}</span>
            <button class="btn small file-dl" data-cid="${escapeHtml(m.file.cid)}" ${busy ? "disabled" : ""}>${busy ? "取得中" : "取得"}</button></span>`;
        } else {
          inner = `<div class="bubble">${escapeHtml(m.text ?? "")}</div>`;
        }
        return `<div class="msg ${m.mine ? "me" : ""}">${avatarHtml(m.origin, who)}
          <div class="bubble-wrap"><div class="who">${escapeHtml(who)}</div>${inner}<div class="time">${time}</div></div></div>`;
      })
      .join("") ||
    `<div class="empty">${
      conv.kind === "dm" ? "暗号化されたDMです。最初のメッセージを送りましょう 🔒" : "まだメッセージはありません 👋"
    }</div>`;
  for (const b of box.querySelectorAll<HTMLButtonElement>(".file-dl")) {
    b.onclick = () => {
      const cid = b.dataset["cid"]!;
      const m = msgs.find((x) => x.file?.cid === cid);
      if (m?.file) void downloadFile(conv, m.file);
    };
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderMembers(): void {
  const conv = activeId ? conversations.get(activeId) : undefined;
  const sec = $("members-sec");
  if (!conv || conv.kind === "dm") {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  const members = conv.memberViews();
  $("peer-count").textContent = String(members.filter((m) => m.connected).length);
  $("member-list").innerHTML =
    members
      .map((m) => {
        const state = m.connected ? "接続中" : m.seen ? "発見済み" : "オフライン";
        const trust = m.banned ? `<span class="badge ng-text">遮断</span>` : m.score !== 0 ? `<span class="badge">信頼 ${m.score}</span>` : "";
        return `<li>${avatarHtml(m.node_id, m.nickname)}
          <div class="m-main"><div class="m-name">${escapeHtml(m.nickname)}</div><div class="m-sub">${state} ${trust}</div></div>
          <button class="btn small dm-btn" data-pk="${escapeHtml(m.pubkey)}">DM</button></li>`;
      })
      .join("") || `<li class="muted">まだ他の参加者がいません</li>`;
  for (const b of $("member-list").querySelectorAll<HTMLButtonElement>(".dm-btn")) {
    b.onclick = () => {
      openDrawer(false);
      void openDm(b.dataset["pk"]!).catch((e) => toast((e as Error).message, "error"));
    };
  }
}

const downloading = new Set<string>();
async function downloadFile(conv: Conversation, meta: FileMeta): Promise<void> {
  if (downloading.has(meta.cid)) return;
  downloading.add(meta.cid);
  void renderChat();
  try {
    const bytes = await conv.fetchBlob(meta);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: meta.mime || "application/octet-stream" }));
    a.download = meta.name || "file";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${meta.name} を取得しました（CID検証済み）`, "ok");
  } catch (e) {
    toast(`取得失敗: ${(e as Error).message}`, "error");
  } finally {
    downloading.delete(meta.cid);
    void renderChat();
  }
}

/** Discovery panel: the scored candidate list the connection logic uses
 * (discovery spec §8), so the layer is inspectable rather than a black box. */
function renderDiscovery(): void {
  const conv = activeId ? conversations.get(activeId) : undefined;
  if (!conv) return;
  const ranked = conv.rankedCandidates();
  $("disc-count").textContent = String(ranked.length);
  $("disc-links").textContent = String(conv.connectedCount());
  $("disc-independent").textContent = conv.relayIndependent() ? "低（メッシュ自立）" : "高（探索中）";
  $("disc-diversity").textContent = String(ranked.reduce((m, c) => Math.max(m, c.relay_count), 0));
  $("disc-list").innerHTML =
    ranked
      .slice(0, 10)
      .map(
        (c, i) =>
          `<li><span class="muted">${i + 1}.</span> <code>${escapeHtml(c.node_id.slice(0, 8))}</code>
           <span class="muted small">score ${c.score.toFixed(1)} · relay×${c.relay_count}${
             c.via_peer_table ? " · peer-table" : ""
           }${c.latency_ms !== undefined ? ` · ${Math.round(c.latency_ms)}ms` : ""}</span></li>`,
      )
      .join("") || `<li class="muted">候補なし</li>`;
}

function renderRelays(): void {
  const list = $("relay-list");
  list.innerHTML =
    relays
      .map(
        (url) =>
          `<li><span style="flex:1;word-break:break-all">${escapeHtml(url)}</span><button class="btn small relay-rm" data-url="${escapeHtml(url)}">削除</button></li>`,
      )
      .join("") || `<li class="muted">未設定（探索できません）</li>`;
  for (const b of list.querySelectorAll<HTMLButtonElement>(".relay-rm")) {
    b.onclick = () => void removeRelay(b.dataset["url"]!);
  }
}

// ---------------------------------------------------------------------------
// Relays (shared across conversations; changing requires rejoin)
// ---------------------------------------------------------------------------

async function addRelay(url: string): Promise<void> {
  if (!/^wss?:\/\//.test(url)) throw new Error("ws:// または wss:// で始めてください");
  if (relays.includes(url)) throw new Error("追加済みです");
  relays = [...relays, url];
  await store.put("kv", "relays", relays);
  renderRelays();
  await rejoinAll();
  toast("Relayを追加しました。再接続します", "ok");
}
async function removeRelay(url: string): Promise<void> {
  relays = relays.filter((r) => r !== url);
  await store.put("kv", "relays", relays);
  renderRelays();
  await rejoinAll();
  toast("Relayを削除しました", "info");
}
async function rejoinAll(): Promise<void> {
  const specs = [...conversations.values()].map((c) => ({ ...c.spec, relays }));
  for (const c of conversations.values()) await c.stop();
  conversations.clear();
  for (const spec of specs) await addConversation(spec, false);
  if (activeId) setActive(activeId);
}

// ---------------------------------------------------------------------------
// Identity / boot
// ---------------------------------------------------------------------------

async function buildIdentity(stored: StoredKeyPair): Promise<Identity> {
  const nodeKeys = await importKeyPair(stored);
  const ecdhKey = await importPrivateKeyForEcdh(stored.privateJwk);
  const myNodeId = await nodeIdFromPubkey(stored.publicKeyHex);
  return { nodeKeys, ecdhKey, myNodeId, pubkeyHex: stored.publicKeyHex };
}

async function firstRun(nick: string, relayUrl: string): Promise<void> {
  const keys = await exportKeyPair(await generateKeyPair());
  await store.put("kv", "identityKeys", keys);
  nickname = nick;
  await store.put("kv", "nickname", nickname);
  relays = relayUrl ? [relayUrl] : defaultRelays();
  await store.put("kv", "relays", relays);
  await boot();
}

async function boot(): Promise<void> {
  const stored = await store.get<StoredKeyPair>("kv", "identityKeys");
  if (!stored) {
    ($("welcome-nick") as HTMLInputElement).value ||= autoNickname();
    const forced = urlRelay();
    if (forced) ($("welcome-relay") as HTMLInputElement).value = forced;
    // hide the relay field only when a same-origin default is usable (http and
    // no explicit relay); show it for file:// or when a relay link was given
    $("welcome-relay-field").hidden = location.protocol.startsWith("http") && !forced;
    $("welcome").hidden = false;
    $("layout").hidden = true;
    return;
  }
  identity = await buildIdentity(stored);
  reputation = Reputation.fromJSON(await store.all<PeerScore>("peers"));
  reputation.onChange = (r) => void store.put("peers", r.node_id, r);
  nickname = (await store.get<string>("kv", "nickname")) ?? autoNickname();
  relays = (await store.get<string[]>("kv", "relays")) ?? defaultRelays();
  // a relay passed in the URL (?relay=… / #relay=…) overrides the stored one,
  // so a single shared link can point a returning user at a new relay
  const forced = urlRelay();
  if (forced && !relays.includes(forced)) {
    relays = [forced, ...relays];
    await store.put("kv", "relays", relays);
  }

  $("welcome").hidden = true;
  $("layout").hidden = false;
  ($("d-nick") as HTMLInputElement).value = nickname;
  ($("my-id") as HTMLInputElement).value = identity.pubkeyHex;
  ($("d-my-id") as HTMLInputElement).value = identity.pubkeyHex;
  renderRelays();

  // restore conversations, then ensure #general exists
  const saved = (await store.get<ConvPersist[]>("kv", "conversations")) ?? [];
  for (const s of saved) {
    await addConversation({ network_id: s.network_id, kind: s.kind, room: s.room, title: s.title, relays, peerPubkey: s.peerPubkey }, false);
  }
  if (![...conversations.values()].some((c) => c.kind === "channel")) {
    await openChannel("general");
  } else {
    renderConvList();
  }
  if (relays.length === 0) {
    toast("Relayが未設定です。設定から追加すると相手を探索できます。", "info");
  }
}

// ---------------------------------------------------------------------------
// Modals / drawer
// ---------------------------------------------------------------------------

function openModal(id: string): void {
  $("modal-scrim").hidden = false;
  $(id).hidden = false;
}
function closeModals(): void {
  $("modal-scrim").hidden = true;
  for (const m of ["modal-channel", "modal-dm"]) $(m).hidden = true;
}
function openDrawer(open: boolean): void {
  $("drawer").hidden = !open;
  $("drawer-scrim").hidden = !open;
  if (open) {
    renderMembers();
    renderRelays();
    renderDiscovery();
  }
}

function busy(btn: HTMLButtonElement, fn: () => Promise<void>): void {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Data actions
// ---------------------------------------------------------------------------

async function setNickname(nick: string): Promise<void> {
  nickname = nick;
  await store.put("kv", "nickname", nickname);
  renderConvList();
  void renderChat();
  toast("表示名を更新しました", "ok");
}

async function exportIdentity(): Promise<void> {
  const keys = await store.get<StoredKeyPair>("kv", "identityKeys");
  const payload = {
    v: 1,
    nickname,
    relays,
    keys,
    conversations: (await store.get<ConvPersist[]>("kv", "conversations")) ?? [],
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  a.download = "anp-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("バックアップを保存しました（秘密鍵を含みます）", "info");
}

async function importIdentity(text: string): Promise<void> {
  const p = JSON.parse(text) as { v: number; nickname?: string; relays?: string[]; keys?: StoredKeyPair; conversations?: ConvPersist[] };
  if (p.v !== 1 || !p.keys?.privateJwk) throw new Error("バックアップの形式が不正です");
  await store.put("kv", "identityKeys", p.keys);
  await store.put("kv", "nickname", p.nickname ?? autoNickname());
  await store.put("kv", "relays", p.relays ?? defaultRelays());
  await store.put("kv", "conversations", p.conversations ?? []);
  location.reload();
}

async function resetAll(): Promise<void> {
  for (const c of conversations.values()) await c.stop();
  await store.clearAll();
  location.reload();
}

async function shareActive(): Promise<void> {
  const conv = activeId ? conversations.get(activeId) : undefined;
  if (!conv) return;
  if (conv.kind === "dm") {
    await copy(identity!.pubkeyHex, "あなたのIDをコピーしました（相手に渡してDMできます）");
    return;
  }
  const link = location.protocol.startsWith("http")
    ? `${location.origin}${location.pathname}#channel=${encodeURIComponent(conv.spec.room ?? "")}`
    : "";
  if (navigator.share && link) {
    try {
      await navigator.share({ title: "ANP Chat", text: `${conv.title} に参加しよう`, url: link });
      return;
    } catch {
      /* fall through */
    }
  }
  await copy(link || conv.title, "共有リンクをコピーしました");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireUi(): void {
  // welcome
  busy($("btn-welcome-start") as HTMLButtonElement, async () => {
    const nick = ($("welcome-nick") as HTMLInputElement).value.trim() || autoNickname();
    const relay = ($("welcome-relay") as HTMLInputElement).value.trim();
    await firstRun(nick, relay);
  });
  $("btn-welcome-import-toggle").onclick = () => {
    const box = $("welcome-import-box");
    box.hidden = !box.hidden;
  };
  busy($("btn-welcome-import") as HTMLButtonElement, async () => {
    const text = ($("welcome-import") as HTMLTextAreaElement).value.trim();
    if (!text) throw new Error("JSONを貼り付けてください");
    await importIdentity(text);
  });

  // sidebar actions
  $("btn-new-channel").onclick = () => {
    ($("channel-name") as HTMLInputElement).value = "";
    openModal("modal-channel");
  };
  $("btn-new-dm").onclick = () => {
    ($("my-id") as HTMLInputElement).value = identity?.pubkeyHex ?? "";
    ($("dm-peer-id") as HTMLInputElement).value = "";
    openModal("modal-dm");
  };
  $("btn-settings").onclick = () => openDrawer(true);

  // modals
  $("modal-scrim").onclick = closeModals;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".modal-cancel")) b.onclick = closeModals;
  busy($("btn-channel-join") as HTMLButtonElement, async () => {
    await openChannel(($("channel-name") as HTMLInputElement).value);
    closeModals();
  });
  $("btn-copy-id").onclick = () => void copy(identity?.pubkeyHex ?? "", "IDをコピーしました");
  busy($("btn-dm-start") as HTMLButtonElement, async () => {
    await openDm(($("dm-peer-id") as HTMLInputElement).value);
    closeModals();
  });

  // chat
  $("btn-back").onclick = () => {
    document.body.classList.remove("chat-open");
  };
  $("conv-title").onclick = () => openDrawer(true);
  $("btn-share").onclick = () => void shareActive();
  const input = $("chat-input") as HTMLInputElement;
  ($("composer") as HTMLFormElement).onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !activeId) return;
    input.value = "";
    void conversations.get(activeId)?.sendChat(text).catch((e) => toast((e as Error).message, "error"));
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      ($("composer") as HTMLFormElement).requestSubmit();
    }
  });
  const fileInput = $("file-input") as HTMLInputElement;
  $("btn-file").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file && activeId) void conversations.get(activeId)?.shareFile(file).catch((e) => toast((e as Error).message, "error"));
  };

  // drawer
  $("btn-drawer-close").onclick = () => openDrawer(false);
  $("drawer-scrim").onclick = () => openDrawer(false);
  busy($("btn-save-nick") as HTMLButtonElement, async () => {
    const nick = ($("d-nick") as HTMLInputElement).value.trim();
    if (!nick) throw new Error("表示名を入力してください");
    await setNickname(nick);
  });
  $("btn-copy-id2").onclick = () => void copy(identity?.pubkeyHex ?? "", "IDをコピーしました");
  busy($("btn-relay-add") as HTMLButtonElement, async () => {
    const el = $("relay-add-url") as HTMLInputElement;
    if (!el.value.trim()) return;
    await addRelay(el.value.trim());
    el.value = "";
  });
  busy($("btn-export") as HTMLButtonElement, () => exportIdentity());
  $("btn-reset").onclick = () => {
    if (confirm("すべての鍵・会話・履歴を削除します。よろしいですか?")) void resetAll();
  };

  // channel link in URL
  window.addEventListener("hashchange", () => void handleChannelHash());
}

async function handleChannelHash(): Promise<void> {
  const m = /[#&]channel=([^&]+)/.exec(location.hash);
  if (m && identity) {
    await openChannel(decodeURIComponent(m[1]!));
    history.replaceState(null, "", location.pathname);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function fatal(msg: string): void {
  document.body.innerHTML = `<div class="overlay"><div class="welcome-card"><h2>起動できません</h2><p class="muted">${escapeHtml(msg)}</p></div></div>`;
}

function acquireSingleTabLock(): Promise<boolean> {
  if (!("locks" in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request("anp-node", { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock) await new Promise(() => {});
    });
  });
}

void (async () => {
  if (!globalThis.crypto?.subtle) {
    fatal("このブラウザは Web Crypto に対応していません。");
    return;
  }
  if (!(await acquireSingleTabLock())) {
    fatal("別のタブで ANP Chat が起動中です。データ保護のためこのタブは停止しました。");
    return;
  }
  try {
    store = await AnpStore.open();
    wireUi();
    await boot();
    await handleChannelHash();
    if (store.ephemeral) toast("この環境では履歴が保存されません（リロードで消えます）。", "info");
  } catch (err) {
    fatal(`初期化に失敗しました: ${(err as Error).message}`);
  }
})();
