// src/shared/crypto.ts
var subtle = globalThis.crypto.subtle;
var ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" };
var SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" };
function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex string");
    out[i] = byte;
  }
  return out;
}
function utf8Encode(text) {
  return new TextEncoder().encode(text);
}
function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - b64.length % 4);
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}
async function sha256Hex(data) {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  const digest = await subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}
async function generateKeyPair() {
  const pair = await subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicKeyHex: bytesToHex(raw) };
}
async function importPublicKeyHex(publicKeyHex) {
  return subtle.importKey("raw", hexToBytes(publicKeyHex), ECDSA_PARAMS, true, ["verify"]);
}
async function exportKeyPair(pair) {
  return {
    publicKeyHex: pair.publicKeyHex,
    privateJwk: await subtle.exportKey("jwk", pair.privateKey)
  };
}
async function importKeyPair(stored) {
  const privateKey = await subtle.importKey("jwk", stored.privateJwk, ECDSA_PARAMS, true, ["sign"]);
  const publicKey = await importPublicKeyHex(stored.publicKeyHex);
  return { publicKey, privateKey, publicKeyHex: stored.publicKeyHex };
}
async function signBytes(privateKey, data) {
  const sig = await subtle.sign(SIGN_PARAMS, privateKey, data);
  return bytesToHex(new Uint8Array(sig));
}
async function verifyBytes(publicKeyHex, signatureHex, data) {
  try {
    const key = await importPublicKeyHex(publicKeyHex);
    return await subtle.verify(SIGN_PARAMS, key, hexToBytes(signatureHex), data);
  } catch {
    return false;
  }
}
async function signObject(privateKey, value, omit = ["signature", "id"]) {
  const clone = { ...value };
  for (const field of omit) delete clone[field];
  return signBytes(privateKey, utf8Encode(canonicalJson(clone)));
}
async function verifyObject(publicKeyHex, value, omit = ["signature", "id"]) {
  const signature = value["signature"];
  if (typeof signature !== "string") return false;
  const clone = { ...value };
  for (const field of omit) delete clone[field];
  return verifyBytes(publicKeyHex, signature, utf8Encode(canonicalJson(clone)));
}
async function objectIdOf(value, omit = ["signature", "id"]) {
  const clone = { ...value };
  for (const field of omit) delete clone[field];
  return sha256Hex(canonicalJson(clone));
}
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}
var ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" };
var HKDF_INFO = utf8Encode("anp-signal-v2");
async function deriveAesKey(privateKey, publicKey, saltHex) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hexToBytes(saltHex), info: HKDF_INFO },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function importPublicKeyForEcdh(publicKeyHex) {
  return subtle.importKey("raw", hexToBytes(publicKeyHex), ECDH_PARAMS, false, []);
}
async function importPrivateKeyForEcdh(privateJwk) {
  const jwk = { ...privateJwk, key_ops: ["deriveBits"] };
  delete jwk["alg"];
  return subtle.importKey("jwk", jwk, ECDH_PARAMS, false, ["deriveBits"]);
}
async function deriveDmKey(myEcdhPrivateKey, peerPubkeyHex, myPubkeyHex) {
  const peer = await importPublicKeyForEcdh(peerPubkeyHex);
  const salt = [myPubkeyHex, peerPubkeyHex].sort().join(":");
  return deriveAesKey(myEcdhPrivateKey, peer, await sha256Hex(salt));
}
async function dmEncrypt(key, plaintext) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, utf8Encode(plaintext));
  return { iv: bytesToHex(iv), ct: base64UrlEncode(new Uint8Array(ct)) };
}
async function dmDecrypt(key, env) {
  try {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(env.iv) },
      key,
      base64UrlDecode(env.ct)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
async function eciesEncrypt(recipientPubkeyHex, plaintext) {
  const eph = await subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const epkHex = bytesToHex(new Uint8Array(await subtle.exportKey("raw", eph.publicKey)));
  const recipient = await importPublicKeyForEcdh(recipientPubkeyHex);
  const aesKey = await deriveAesKey(eph.privateKey, recipient, epkHex + recipientPubkeyHex);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  return { epk: epkHex, iv: bytesToHex(iv), ct: base64UrlEncode(new Uint8Array(ct)) };
}
async function eciesDecrypt(recipientPrivateEcdh, recipientPubkeyHex, envelope) {
  const epk = await importPublicKeyForEcdh(envelope.epk);
  const aesKey = await deriveAesKey(recipientPrivateEcdh, epk, envelope.epk + recipientPubkeyHex);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(envelope.iv) },
    aesKey,
    base64UrlDecode(envelope.ct)
  );
  return new Uint8Array(pt);
}
function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const nibble = Number.parseInt(ch, 16);
    if (Number.isNaN(nibble)) return bits;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}
function hasPow(idHex, bits) {
  return leadingZeroBits(idHex) >= bits;
}

// src/shared/types.ts
var PROTOCOL_VERSION = 2;

// src/shared/identity.ts
var MAX_CHAIN_LENGTH = 16;
var DOMAIN_TAG = "anp-network";
function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
var OPEN_PREFIX = "anp-open-v1:";
async function openNetworkId(room) {
  return sha256Hex(utf8Encode(OPEN_PREFIX + room));
}
function normalizeRoom(room) {
  return room.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}
function dmRoom(pubkeyA, pubkeyB) {
  const [a, b] = [pubkeyA, pubkeyB].sort();
  return `dm:${a}:${b}`;
}
function dmPubkeys(room) {
  const m = /^dm:([0-9a-f]{130}):([0-9a-f]{130})$/.exec(room);
  return m ? [m[1], m[2]] : null;
}
function isDmRoom(room) {
  return typeof room === "string" && room.startsWith("dm:");
}
async function dmNetworkId(pubkeyA, pubkeyB) {
  return openNetworkId(dmRoom(pubkeyA, pubkeyB));
}
async function networkIdFromGenesisPubkey(genesisPubkeyHex, proto = PROTOCOL_VERSION) {
  return sha256Hex(concatBytes(hexToBytes(genesisPubkeyHex), utf8Encode(`|${proto}|${DOMAIN_TAG}`)));
}
async function nodeIdFromPubkey(pubkeyHex) {
  return sha256Hex(hexToBytes(pubkeyHex));
}
async function verifyCertificate(cert, now = nowSeconds()) {
  if (cert.type !== "INVITE") return false;
  if (cert.revoked) return false;
  if (cert.expires_at <= now) return false;
  return verifyObject(cert.issuer_pubkey, cert, ["signature"]);
}
async function verifyInviteChain(networkId, chain, subjectPubkey, now = nowSeconds(), revoked, ignoreExpiry = false) {
  if (await networkIdFromGenesisPubkey(subjectPubkey) === networkId) {
    return { ok: true, rights: ["join", "invite", "chat", "store", "admin"] };
  }
  if (chain.length === 0) return { ok: false, rights: [], reason: "empty invite chain" };
  if (chain.length > MAX_CHAIN_LENGTH) {
    return { ok: false, rights: [], reason: "invite chain too long" };
  }
  const first = chain[0];
  if (await networkIdFromGenesisPubkey(first.issuer_pubkey) !== networkId) {
    return { ok: false, rights: [], reason: "chain not rooted at genesis key" };
  }
  const genesisPubkey = first.issuer_pubkey;
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (cert.network_id !== networkId) return { ok: false, rights: [], reason: `link ${i}: wrong network` };
    const certNow = ignoreExpiry ? cert.issued_at + 1 : now;
    if (!await verifyCertificate(cert, certNow)) {
      return { ok: false, rights: [], reason: `link ${i}: invalid, revoked or expired` };
    }
    if (isCertRevoked(cert, genesisPubkey, revoked)) {
      return { ok: false, rights: [], reason: `link ${i}: certificate revoked (${cert.invite_id})` };
    }
    if (i > 0) {
      const prev = chain[i - 1];
      if (cert.issuer_pubkey !== prev.subject_pubkey) {
        return { ok: false, rights: [], reason: `link ${i}: broken chain` };
      }
      if (!prev.rights.includes("invite")) {
        return { ok: false, rights: [], reason: `link ${i - 1}: issuer lacks invite right` };
      }
      if (!cert.rights.every((right) => prev.rights.includes(right))) {
        return { ok: false, rights: [], reason: `link ${i}: rights exceed issuer's rights` };
      }
    }
  }
  const last = chain[chain.length - 1];
  if (last.subject_pubkey !== subjectPubkey) {
    return { ok: false, rights: [], reason: "chain does not name this node" };
  }
  if (!last.rights.includes("join")) {
    return { ok: false, rights: [], reason: "final link lacks join right" };
  }
  return { ok: true, rights: last.rights };
}
function isCertRevoked(cert, genesisPubkey, revoked) {
  const revokers = revoked?.get(cert.invite_id);
  if (!revokers) return false;
  return revokers.has(cert.issuer_pubkey) || revokers.has(genesisPubkey);
}

// src/client/store.ts
var DB_NAME = "anp";
var DB_VERSION = 2;
var STORES = ["kv", "peers", "crdt", "ns", "blobs", "members"];
var IdbBackend = class _IdbBackend {
  constructor(db) {
    this.db = db;
  }
  static open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        return reject(err);
      }
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(new _IdbBackend(req.result));
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  }
  tx(store2, mode, fn) {
    return new Promise((resolve, reject) => {
      const req = fn(this.db.transaction(store2, mode).objectStore(store2));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  get(store2, key) {
    return this.tx(store2, "readonly", (s) => s.get(key));
  }
  put(store2, key, value) {
    return this.tx(store2, "readwrite", (s) => s.put(value, key)).then(() => void 0);
  }
  delete(store2, key) {
    return this.tx(store2, "readwrite", (s) => s.delete(key)).then(() => void 0);
  }
  all(store2) {
    return this.tx(store2, "readonly", (s) => s.getAll());
  }
  clearAll() {
    return Promise.all(STORES.map((s) => this.tx(s, "readwrite", (os) => os.clear()))).then(() => void 0);
  }
};
var MemoryBackend = class {
  maps = {
    kv: /* @__PURE__ */ new Map(),
    peers: /* @__PURE__ */ new Map(),
    crdt: /* @__PURE__ */ new Map(),
    ns: /* @__PURE__ */ new Map(),
    blobs: /* @__PURE__ */ new Map(),
    members: /* @__PURE__ */ new Map()
  };
  async get(store2, key) {
    return this.maps[store2].get(key);
  }
  async put(store2, key, value) {
    this.maps[store2].set(key, value);
  }
  async delete(store2, key) {
    this.maps[store2].delete(key);
  }
  async all(store2) {
    return [...this.maps[store2].values()];
  }
  async clearAll() {
    for (const map of Object.values(this.maps)) map.clear();
  }
};
var AnpStore = class _AnpStore {
  constructor(backend, ephemeral) {
    this.backend = backend;
    this.ephemeral = ephemeral;
  }
  /** true when persistence is unavailable (in-memory fallback in use) */
  ephemeral;
  static async open() {
    try {
      return new _AnpStore(await IdbBackend.open(), false);
    } catch {
      return new _AnpStore(new MemoryBackend(), true);
    }
  }
  get(store2, key) {
    return this.backend.get(store2, key);
  }
  put(store2, key, value) {
    return this.backend.put(store2, key, value);
  }
  delete(store2, key) {
    return this.backend.delete(store2, key);
  }
  all(store2) {
    return this.backend.all(store2);
  }
  clearAll() {
    return this.backend.clearAll();
  }
};

// src/shared/reputation.ts
var SCORE_MIN = -100;
var SCORE_MAX = 100;
var BAN_THRESHOLD = -50;
var DECAY = 0.9;
var EVENT_DELTAS = {
  connect: 2,
  "valid-sync": 0.2,
  "file-served": 3,
  "forged-entry": -5,
  "bad-revocation": -3,
  "file-failed": -3,
  "keepalive-timeout": -2,
  "pc-failed": -1
};
var Reputation = class _Reputation {
  scores = /* @__PURE__ */ new Map();
  /** invoked (debounced by the caller) whenever a score changes */
  onChange;
  record(nodeId, event, now = Math.floor(Date.now() / 1e3)) {
    const delta = EVENT_DELTAS[event];
    let entry = this.scores.get(nodeId);
    if (!entry) {
      entry = { node_id: nodeId, score: 0, good: 0, bad: 0, updated_at: now };
      this.scores.set(nodeId, entry);
    }
    entry.score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, entry.score + delta));
    if (delta >= 0) entry.good += 1;
    else entry.bad += 1;
    entry.updated_at = now;
    this.onChange?.(entry);
    return entry;
  }
  scoreOf(nodeId) {
    return this.scores.get(nodeId)?.score ?? 0;
  }
  get(nodeId) {
    return this.scores.get(nodeId);
  }
  isBanned(nodeId) {
    return this.scoreOf(nodeId) <= BAN_THRESHOLD;
  }
  /** Sort node ids by score, best first (stable for equal scores). */
  rank(nodeIds) {
    return [...nodeIds].sort((a, b) => this.scoreOf(b) - this.scoreOf(a));
  }
  reset(nodeId) {
    if (nodeId) this.scores.delete(nodeId);
    else this.scores.clear();
  }
  all() {
    return [...this.scores.values()].sort((a, b) => b.score - a.score);
  }
  toJSON() {
    return this.all();
  }
  /**
   * Load persisted scores, applying restart decay so old grudges (and stale
   * praise) fade: score *= DECAY, and entries that have decayed to ~0 with no
   * recent activity are dropped.
   */
  static fromJSON(records, decay2 = DECAY) {
    const rep = new _Reputation();
    for (const record of records ?? []) {
      if (!record || typeof record.node_id !== "string" || typeof record.score !== "number") continue;
      const score = record.score * decay2;
      if (Math.abs(score) < 0.5) continue;
      rep.scores.set(record.node_id, { ...record, score });
    }
    return rep;
  }
};

// src/shared/events.ts
var JOIN_TTL = 300;
var HEARTBEAT_TTL = 90;
var HEARTBEAT_INTERVAL = 30;
var SIGNAL_TTL = 60;
var MANIFEST_TTL = 600;
var POW_BITS = 12;
var POW_MAX_ITERATIONS = 2e6;
async function createEvent(opts) {
  const createdAt = nowSeconds();
  const event = {
    id: "",
    type: opts.type,
    network_id: opts.networkId,
    node_id: await nodeIdFromPubkey(opts.keys.publicKeyHex),
    pubkey: opts.keys.publicKeyHex,
    created_at: createdAt,
    expires_at: createdAt + opts.ttl,
    body: opts.body,
    signature: ""
  };
  event.signature = await signObject(opts.keys.privateKey, event);
  event.id = await objectIdOf(event);
  return event;
}
async function verifyEvent(event, opts = {}) {
  try {
    return await verifyEventInner(event, opts);
  } catch (err) {
    return { ok: false, reason: `malformed event: ${err.message}` };
  }
}
async function verifyEventInner(event, opts) {
  const now = opts.now ?? nowSeconds();
  if (!event || typeof event !== "object") return { ok: false, reason: "not an object" };
  const { type, network_id, node_id, pubkey, signature } = event;
  if (!["JOIN", "HEARTBEAT", "LEAVE", "MANIFEST", "INVITE", "SIGNAL"].includes(type)) {
    return { ok: false, reason: "unknown event type" };
  }
  if (typeof network_id !== "string" || !/^[0-9a-f]{64}$/.test(network_id)) {
    return { ok: false, reason: "bad network_id" };
  }
  if (typeof pubkey !== "string" || !/^[0-9a-f]{130}$/.test(pubkey) || typeof signature !== "string") {
    return { ok: false, reason: "missing or malformed pubkey/signature" };
  }
  if (typeof event.expires_at !== "number" || event.expires_at <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof event.created_at !== "number" || event.created_at > now + 300) {
    return { ok: false, reason: "created_at in the future" };
  }
  if (event.expires_at - event.created_at > 24 * 3600) {
    return { ok: false, reason: "ttl too long" };
  }
  if (await nodeIdFromPubkey(pubkey) !== node_id) {
    return { ok: false, reason: "node_id does not match pubkey" };
  }
  if (await objectIdOf(event) !== event.id) {
    return { ok: false, reason: "id mismatch" };
  }
  if (!await verifyObject(pubkey, event)) {
    return { ok: false, reason: "bad signature" };
  }
  if (event.type === "JOIN") {
    const powBits = opts.powBits ?? POW_BITS;
    if (powBits > 0 && !hasPow(event.id, powBits)) {
      return { ok: false, reason: `insufficient proof-of-work (need ${powBits} bits)` };
    }
    const body = event.body;
    if (body?.open) {
      if (typeof body.room !== "string" || !body.room) {
        return { ok: false, reason: "open join missing room" };
      }
      if (await openNetworkId(body.room) !== network_id) {
        return { ok: false, reason: "room does not match network id" };
      }
      if (isDmRoom(body.room)) {
        const pair = dmPubkeys(body.room);
        if (!pair || !pair.includes(pubkey)) {
          return { ok: false, reason: "not a party to this DM" };
        }
      }
    } else {
      const chain = body?.invite_chain ?? [];
      const check = await verifyInviteChain(network_id, chain, pubkey, now, opts.revoked);
      if (!check.ok) return { ok: false, reason: `invite chain: ${check.reason}` };
    }
  }
  if (event.type === "SIGNAL") {
    const body = event.body;
    if (typeof body?.target !== "string" || typeof body?.session !== "string" || typeof body?.seq !== "number" || typeof body?.enc?.epk !== "string" || typeof body?.enc?.iv !== "string" || typeof body?.enc?.ct !== "string") {
      return { ok: false, reason: "malformed signal body" };
    }
  }
  if (event.type === "INVITE") {
    const cert = event.body?.certificate;
    if (!cert || cert.type !== "INVITE") return { ok: false, reason: "malformed invite body" };
    if (cert.network_id !== network_id) return { ok: false, reason: "invite for another network" };
    if (cert.issuer_pubkey !== pubkey) return { ok: false, reason: "invite not published by its issuer" };
    if (!await verifyCertificate(cert, now)) return { ok: false, reason: "invalid certificate" };
  }
  return { ok: true };
}
async function createJoin(networkId, keys, inviteChain, nicknameOrOpts, powBitsArg = POW_BITS) {
  const opts = typeof nicknameOrOpts === "string" || nicknameOrOpts === void 0 ? { nickname: nicknameOrOpts, powBits: powBitsArg } : nicknameOrOpts;
  const powBits = opts.powBits ?? POW_BITS;
  const createdAt = nowSeconds();
  const event = {
    id: "",
    type: "JOIN",
    network_id: networkId,
    node_id: await nodeIdFromPubkey(keys.publicKeyHex),
    pubkey: keys.publicKeyHex,
    created_at: createdAt,
    expires_at: createdAt + JOIN_TTL,
    body: {
      proto: PROTOCOL_VERSION,
      transport: { kind: "webrtc" },
      invite_chain: inviteChain,
      pow_nonce: "",
      nickname: opts.nickname,
      ...opts.open ? { open: true, room: opts.room } : {}
    },
    signature: ""
  };
  for (let i = 0; i < POW_MAX_ITERATIONS; i++) {
    event.body.pow_nonce = randomHex(8);
    const id = await objectIdOf(event);
    if (powBits <= 0 || hasPow(id, powBits)) {
      event.signature = await signObject(keys.privateKey, event);
      event.id = id;
      return event;
    }
  }
  throw new Error("proof-of-work search exhausted");
}
async function createHeartbeat(networkId, keys) {
  return createEvent({ type: "HEARTBEAT", networkId, keys, ttl: HEARTBEAT_TTL, body: {} });
}
async function createLeave(networkId, keys) {
  return createEvent({ type: "LEAVE", networkId, keys, ttl: HEARTBEAT_TTL, body: {} });
}
async function createManifest(networkId, keys, body) {
  return createEvent({ type: "MANIFEST", networkId, keys, ttl: MANIFEST_TTL, body });
}
async function createSignal(networkId, keys, target, targetPubkey, session, seq, payload) {
  const enc = await eciesEncrypt(targetPubkey, utf8Encode(JSON.stringify(payload)));
  const body = { target, session, seq, enc };
  return createEvent({ type: "SIGNAL", networkId, keys, ttl: SIGNAL_TTL, body });
}
async function decryptSignal(myEcdhPrivateKey, myPubkeyHex, enc) {
  try {
    const plaintext = await eciesDecrypt(myEcdhPrivateKey, myPubkeyHex, enc);
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (payload.kind !== "offer" && payload.kind !== "answer" && payload.kind !== "ice") return null;
    return payload;
  } catch {
    return null;
  }
}

// src/shared/crdt.ts
function replicaNodeId(replica) {
  const dot = replica.indexOf(".");
  return dot === -1 ? replica : replica.slice(0, dot);
}
async function signLogEntry(privateKey, publicKeyHex, entry) {
  entry.pubkey = publicKeyHex;
  const clone = { ...entry };
  delete clone["sig"];
  entry.sig = await signBytes(privateKey, utf8Encode(canonicalJson(clone)));
  return entry;
}
async function verifyLogEntry(entry) {
  try {
    if (!entry || typeof entry.id !== "string" || typeof entry.origin !== "string") return false;
    if (typeof entry.seq !== "number" || typeof entry.lamport !== "number") return false;
    if (entry.id !== `${entry.origin}:${entry.seq}`) return false;
    if (typeof entry.pubkey !== "string" || typeof entry.sig !== "string") return false;
    if (await sha256Hex(hexToBytes(entry.pubkey)) !== replicaNodeId(entry.origin)) return false;
    const clone = { ...entry };
    delete clone["sig"];
    return await verifyBytes(entry.pubkey, entry.sig, utf8Encode(canonicalJson(clone)));
  } catch {
    return false;
  }
}
var GSetLog = class _GSetLog {
  constructor(origin) {
    this.origin = origin;
  }
  entries = /* @__PURE__ */ new Map();
  /** origin -> highest contiguous-agnostic max seq seen */
  vv = {};
  lamport = 0;
  append(kind, data, ts = nowSeconds()) {
    this.lamport += 1;
    const seq = (this.vv[this.origin] ?? 0) + 1;
    const entry = {
      id: `${this.origin}:${seq}`,
      origin: this.origin,
      seq,
      lamport: this.lamport,
      ts,
      kind,
      data
    };
    this.entries.set(entry.id, entry);
    this.vv[this.origin] = seq;
    return entry;
  }
  /** Merge remote entries; returns the entries that were new to us. */
  merge(remote) {
    const added = [];
    for (const entry of remote) {
      if (!entry || typeof entry.id !== "string" || this.entries.has(entry.id)) continue;
      if (entry.id !== `${entry.origin}:${entry.seq}`) continue;
      this.entries.set(entry.id, entry);
      if (entry.lamport > this.lamport) this.lamport = entry.lamport;
      if (entry.seq > (this.vv[entry.origin] ?? 0)) this.vv[entry.origin] = entry.seq;
      added.push(entry);
    }
    return added;
  }
  /** All entries in the converged total order. */
  ordered() {
    return [...this.entries.values()].sort(
      (a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }
  /** Snapshot of our per-origin high-water marks. */
  versionVector() {
    return { ...this.vv };
  }
  /**
   * Delta for a peer that has seen `remote` (their version vector): every
   * entry whose seq exceeds their mark for its origin. Unlike a lamport
   * watermark, this cannot skip entries from origins the peer has never
   * heard of.
   */
  entriesMissingFrom(remote) {
    return this.ordered().filter((entry) => entry.seq > (remote[entry.origin] ?? 0));
  }
  size() {
    return this.entries.size;
  }
  toJSON() {
    return this.ordered();
  }
  static fromJSON(origin, entries) {
    const log2 = new _GSetLog(origin);
    log2.merge(entries ?? []);
    return log2;
  }
};

// src/shared/discovery.ts
var WEIGHTS = {
  invite: 40,
  freshness: 25,
  heartbeat: 20,
  relayDiversity: 10,
  latency: 15
};
var LATENCY_CEILING_MS = 500;
var LATENCY_UNKNOWN = 0.5;
var clamp01 = (n) => n < 0 ? 0 : n > 1 ? 1 : n;
function decay(at, now, ttl) {
  if (!at) return 0;
  return clamp01(1 - (now - at) / ttl);
}
function scoreCandidate(c, now) {
  const invite = c.invite_match ? WEIGHTS.invite : 0;
  const freshness = WEIGHTS.freshness * decay(c.join_at, now, JOIN_TTL);
  const heartbeat = WEIGHTS.heartbeat * decay(c.heartbeat_at, now, HEARTBEAT_TTL);
  const diversity = WEIGHTS.relayDiversity * clamp01((c.relay_count - 1) / 2);
  const latency = WEIGHTS.latency * (c.latency_ms === void 0 ? LATENCY_UNKNOWN : clamp01(1 - c.latency_ms / LATENCY_CEILING_MS));
  return invite + freshness + heartbeat + diversity + latency;
}
function rankCandidates(candidates, now) {
  return candidates.map((c) => ({ ...c, score: scoreCandidate(c, now) })).sort((a, b) => {
    const d = Math.round((b.score - a.score) * 1e6);
    if (d !== 0) return d;
    return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
  });
}
function isViable(c, now) {
  if (c.via_peer_table && now - c.join_at <= JOIN_TTL) return true;
  return decay(c.join_at, now, JOIN_TTL) > 0 || decay(c.heartbeat_at, now, HEARTBEAT_TTL) > 0;
}
function selectConnectTargets(ranked, opts) {
  const free = opts.maxLinks - opts.active.size;
  if (free <= 0) return [];
  const out = [];
  for (const c of ranked) {
    if (out.length >= free) break;
    if (opts.active.has(c.node_id)) continue;
    if (opts.skip?.(c.node_id)) continue;
    out.push(c.node_id);
  }
  return out;
}

// src/shared/nameservice.ts
var REVOKED_PREFIX = "revoked/";
function parseRevocationName(name) {
  if (!name.startsWith(REVOKED_PREFIX)) return null;
  const rest = name.slice(REVOKED_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const inviteId = rest.slice(0, slash);
  const authorPubkey = rest.slice(slash + 1);
  if (!/^[0-9a-f]{130}$/.test(authorPubkey)) return null;
  return { inviteId, authorPubkey };
}
function isValidRevocationRecord(record) {
  const parts = parseRevocationName(record.name);
  if (!parts) return false;
  if (parts.authorPubkey !== record.author_pubkey) return false;
  const value = record.value;
  return value?.kind === "revocation" && value.invite_id === parts.inviteId;
}
async function createNameRecord(networkId, keys, name, value, version, ttl = 600) {
  const record = {
    network_id: networkId,
    name,
    value,
    version,
    ttl,
    updated_at: nowSeconds(),
    author_pubkey: keys.publicKeyHex,
    signature: ""
  };
  record.signature = await signObject(keys.privateKey, record, [
    "signature"
  ]);
  return record;
}
async function verifyNameRecord(record) {
  if (!record || typeof record.name !== "string" || typeof record.version !== "number") return false;
  return verifyObject(record.author_pubkey, record, ["signature"]);
}
function isExpired(record, now = nowSeconds()) {
  return record.updated_at + record.ttl <= now;
}
function pickNewer(a, b) {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return a.signature >= b.signature ? a : b;
}
var NameServiceStore = class {
  constructor(networkId) {
    this.networkId = networkId;
  }
  records = /* @__PURE__ */ new Map();
  /** Merge one record in; returns true if it became the winner for its name. */
  async merge(record, now = nowSeconds()) {
    if (record.network_id !== this.networkId) return false;
    if (isExpired(record, now)) return false;
    if (typeof record.name !== "string") return false;
    if (record.name.startsWith(REVOKED_PREFIX) && !isValidRevocationRecord(record)) return false;
    if (!await verifyNameRecord(record)) return false;
    const current = this.records.get(record.name);
    if (!current || isExpired(current, now)) {
      this.records.set(record.name, record);
      return true;
    }
    if (pickNewer(record, current) === record && record.signature !== current.signature) {
      this.records.set(record.name, record);
      return true;
    }
    return false;
  }
  resolve(name, now = nowSeconds()) {
    const record = this.records.get(name);
    if (!record) return void 0;
    if (isExpired(record, now)) {
      this.records.delete(record.name);
      return void 0;
    }
    return record;
  }
  all(now = nowSeconds()) {
    for (const [name, record] of this.records) {
      if (isExpired(record, now)) this.records.delete(name);
    }
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  load(records) {
    for (const record of records) {
      const current = this.records.get(record.name);
      this.records.set(record.name, current ? pickNewer(record, current) : record);
    }
  }
  /**
   * Extract the revocation map from `revoked/<invite_id>/<author>` records.
   * Each valid record contributes its author to the invite's revoker set; the
   * map only carries who *claimed* each revocation, and authority (issuer or
   * genesis) is judged at chain-verification time by `isCertRevoked`.
   */
  revocations(now = nowSeconds()) {
    const map = /* @__PURE__ */ new Map();
    for (const record of this.all(now)) {
      if (!record.name.startsWith(REVOKED_PREFIX)) continue;
      if (!isValidRevocationRecord(record)) continue;
      const value = record.value;
      let revokers = map.get(value.invite_id);
      if (!revokers) {
        revokers = /* @__PURE__ */ new Set();
        map.set(value.invite_id, revokers);
      }
      revokers.add(record.author_pubkey);
    }
    return map;
  }
};

// src/client/relayclient.ts
var BACKOFF_BASE_MS = 1500;
var BACKOFF_MAX_MS = 3e4;
var MAX_QUEUED = 256;
var MAX_SEEN_IDS = 1e4;
var RelayPool = class {
  constructor(opts) {
    this.opts = opts;
  }
  conns = /* @__PURE__ */ new Map();
  /** event id -> the (node, type) it was verified as, so a duplicate can be
   * attributed to a relay without re-verifying, and cannot be re-attributed
   * to a different node by a lying relay. */
  seen = /* @__PURE__ */ new Map();
  closed = false;
  start() {
    for (const url of this.opts.urls) this.addRelay(url);
  }
  /** Add and connect a relay at runtime (bootstrap adoption / manual edit). */
  addRelay(url) {
    if (this.closed || this.conns.has(url)) return;
    const conn = {
      url,
      attempts: 0,
      queue: [],
      stats: {
        url,
        connected: false,
        eventsReceived: 0,
        eventsAccepted: 0,
        eventsRejected: 0,
        lastEventAt: 0
      }
    };
    this.conns.set(url, conn);
    this.connect(conn);
  }
  /** Remove a relay at runtime (manual edit). */
  removeRelay(url) {
    const conn = this.conns.get(url);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.ws?.close();
    this.conns.delete(url);
  }
  stop() {
    this.closed = true;
    for (const conn of this.conns.values()) {
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      conn.ws?.close();
    }
    this.conns.clear();
  }
  connectedCount() {
    let n = 0;
    for (const conn of this.conns.values()) if (conn.stats.connected) n++;
    return n;
  }
  statsSnapshot() {
    return [...this.conns.values()].map((c) => ({ ...c.stats }));
  }
  scheduleReconnect(conn) {
    if (this.closed) return;
    conn.attempts += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (conn.attempts - 1));
    const jitter = delay * (0.5 + Math.random() * 0.5);
    conn.reconnectTimer = setTimeout(() => this.connect(conn), jitter);
  }
  connect(conn) {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(conn.url);
    } catch (err) {
      conn.stats.lastError = err.message;
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    ws.onopen = () => {
      conn.attempts = 0;
      conn.stats.connected = true;
      conn.stats.lastError = void 0;
      this.opts.onStatus?.(conn.url, true);
      this.sendFrame(ws, { frame: "REQ", sub_id: "main", filter: this.opts.filter });
      const now = nowSeconds();
      const queued = conn.queue.splice(0);
      for (const event of queued) {
        if (event.expires_at > now) this.sendFrame(ws, { frame: "EVENT", event });
      }
    };
    ws.onmessage = async (msg) => {
      let frame;
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (frame.frame === "OK") {
        if (frame.accepted) conn.stats.eventsAccepted++;
        else {
          conn.stats.eventsRejected++;
          conn.stats.lastError = frame.message;
        }
        return;
      }
      if (frame.frame === "EVENT") {
        const event = frame.event;
        conn.stats.eventsReceived++;
        conn.stats.lastEventAt = nowSeconds();
        const known = this.seen.get(event.id);
        if (known) {
          if (known.node_id === event.node_id && known.type === event.type) {
            this.opts.onSighting?.(event, conn.url);
          }
          return;
        }
        const check = await verifyEvent(event, { powBits: 0 });
        if (!check.ok) return;
        if (this.seen.has(event.id)) return;
        this.seen.set(event.id, { node_id: event.node_id, type: event.type });
        if (this.seen.size > MAX_SEEN_IDS) {
          const ids = [...this.seen.keys()];
          for (const id of ids.slice(0, ids.length / 2)) this.seen.delete(id);
        }
        this.opts.onSighting?.(event, conn.url);
        this.opts.onEvent(event, conn.url);
      }
    };
    ws.onclose = () => {
      conn.stats.connected = false;
      if (conn.ws === ws) conn.ws = void 0;
      this.opts.onStatus?.(conn.url, false);
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {
      conn.stats.lastError = "socket error";
      ws.close();
    };
  }
  /** Publish to every relay; queues for relays that are currently down. */
  publish(event) {
    this.seen.set(event.id, { node_id: event.node_id, type: event.type });
    for (const conn of this.conns.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        this.sendFrame(conn.ws, { frame: "EVENT", event });
      } else {
        conn.queue.push(event);
        if (conn.queue.length > MAX_QUEUED) conn.queue.shift();
      }
    }
  }
  sendFrame(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
    }
  }
};

// src/client/webrtc.ts
var RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};
var HANDSHAKE_TIMEOUT_MS = 25e3;
var PING_INTERVAL_MS = 15e3;
var PONG_DEADLINE_MS = 5e4;
var RETRY_BASE_MS = 4e3;
var RETRY_MAX_MS = 6e4;
var MAX_DC_FRAME_BYTES = 512 * 1024;
var MAX_ACTIVE_LINKS = 8;
var MAX_TOTAL_LINKS = 16;
var Mesh = class {
  constructor(networkId, keys, ecdhKey, myNodeId, cb) {
    this.networkId = networkId;
    this.keys = keys;
    this.ecdhKey = ecdhKey;
    this.myNodeId = myNodeId;
    this.cb = cb;
  }
  /** peers known from discovery (valid JOIN seen) */
  peers = /* @__PURE__ */ new Map();
  links = /* @__PURE__ */ new Map();
  /** per-peer reconnect backoff */
  attempts = /* @__PURE__ */ new Map();
  /** connection order from the discovery scorer, best-first (§8.3) */
  priority = [];
  retryTimers = /* @__PURE__ */ new Map();
  stopped = false;
  /** Called for every verified discovery event from the relay pool. */
  async handleDiscoveryEvent(event) {
    if (this.stopped || event.node_id === this.myNodeId) return;
    switch (event.type) {
      case "JOIN": {
        const existing = this.peers.get(event.node_id);
        this.peers.set(event.node_id, {
          node_id: event.node_id,
          pubkey: event.pubkey,
          nickname: event.body.nickname ?? existing?.nickname,
          last_seen: Math.max(event.created_at, existing?.last_seen ?? 0),
          rights: existing?.rights ?? []
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
        const peer = this.peers.get(event.node_id);
        if (peer && event.created_at < peer.last_seen) break;
        const liveLink = this.links.get(event.node_id);
        if (liveLink?.state === "open" && liveLink.dc?.readyState === "open") break;
        this.dropLinkById(event.node_id, "peer left");
        this.peers.delete(event.node_id);
        this.clearRetry(event.node_id);
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
  /**
   * Connection order from the discovery scorer (§8.3 Step 5). Setting it also
   * fills any free link slots with the best remaining candidates, which is how
   * §12.2 "次点の候補へ進む" happens after a failure.
   */
  setPriority(ordered) {
    this.priority = ordered;
    this.fillSlots();
  }
  /** Open links to the best candidates until the degree cap is reached. */
  fillSlots() {
    if (this.stopped) return;
    const targets = selectConnectTargets(
      this.priority.map((node_id) => ({ node_id })),
      {
        active: new Set(this.links.keys()),
        maxLinks: MAX_ACTIVE_LINKS,
        // responders wait for the other side; peers still backing off are skipped
        skip: (id) => {
          if (this.myNodeId >= id) return true;
          if (!this.peers.has(id)) return true;
          const attempt = this.attempts.get(id);
          return !!attempt && Date.now() < attempt.nextAt;
        }
      }
    );
    for (const nodeId of targets) void this.initiate(nodeId);
  }
  /** Initiate to peers we should connect to (smaller node_id initiates). */
  maybeConnect(nodeId) {
    if (this.stopped || this.links.has(nodeId)) return;
    if (this.myNodeId >= nodeId) return;
    const attempt = this.attempts.get(nodeId);
    if (attempt && Date.now() < attempt.nextAt) return;
    if (this.links.size >= MAX_ACTIVE_LINKS) return;
    void this.initiate(nodeId);
  }
  recordFailure(nodeId) {
    const attempt = this.attempts.get(nodeId) ?? { count: 0, nextAt: 0 };
    attempt.count += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt.count - 1));
    const jitter = delay * (0.5 + Math.random() * 0.5);
    attempt.nextAt = Date.now() + jitter;
    this.attempts.set(nodeId, attempt);
    this.clearRetry(nodeId);
    if (this.stopped) return;
    this.retryTimers.set(
      nodeId,
      setTimeout(() => {
        this.retryTimers.delete(nodeId);
        if (this.peers.has(nodeId)) this.maybeConnect(nodeId);
      }, jitter + 100)
    );
  }
  clearRetry(nodeId) {
    const timer = this.retryTimers.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(nodeId);
    }
  }
  newLink(nodeId, session, initiator, peerPubkey, sessionStartedAt) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const link = {
      pc,
      session,
      initiator,
      state: "connecting",
      peerPubkey,
      txSeq: 0,
      rxSeen: /* @__PURE__ */ new Set(),
      pendingCandidates: [],
      haveRemote: false,
      sessionStartedAt,
      lastPongAt: Date.now()
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
      void this.sendSignal(nodeId, link, { kind: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (this.links.get(nodeId) !== link) return;
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.dropLink(nodeId, link, `pc ${state}`);
        this.recordFailure(nodeId);
        this.cb.onPeerClose(nodeId, `pc ${state}`);
      }
    };
    return link;
  }
  async sendSignal(nodeId, link, payload) {
    try {
      const event = await createSignal(
        this.networkId,
        this.keys,
        nodeId,
        link.peerPubkey,
        link.session,
        link.txSeq++,
        payload
      );
      this.cb.publishEvent(event);
    } catch (err) {
      this.cb.log(`signal encrypt failed for ${short(nodeId)}: ${err.message}`);
    }
  }
  async initiate(nodeId) {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    const session = randomHex(8);
    const link = this.newLink(nodeId, session, true, peer.pubkey, nowSeconds());
    const dc = link.pc.createDataChannel("anp", { ordered: true });
    this.wireDc(nodeId, link, dc);
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      if (this.links.get(nodeId) !== link) return;
      await this.sendSignal(nodeId, link, { kind: "offer", sdp: link.pc.localDescription.sdp });
      this.cb.log(`offer -> ${short(nodeId)} (session ${session})`);
    } catch (err) {
      this.cb.log(`offer failed for ${short(nodeId)}: ${err.message}`);
      if (this.links.get(nodeId) === link) {
        this.dropLink(nodeId, link, "offer failed");
        this.recordFailure(nodeId);
      }
    }
  }
  async handleSignal(event) {
    if (event.body.target !== this.myNodeId) return;
    const from = event.node_id;
    const peer = this.peers.get(from);
    if (!peer) {
      this.cb.log(`signal from unknown node ${short(from)} ignored`);
      return;
    }
    if (peer.pubkey !== event.pubkey) return;
    const { session, seq } = event.body;
    const payload = await decryptSignal(this.ecdhKey, this.keys.publicKeyHex, event.body.enc);
    if (!payload) {
      this.cb.log(`undecryptable signal from ${short(from)} dropped`);
      return;
    }
    if (payload.kind === "offer") {
      const existing = this.links.get(from);
      if (existing) {
        if (existing.session === session) return;
        if (event.created_at <= existing.sessionStartedAt) return;
        if (existing.state === "open") {
          this.dropLink(from, existing, "superseded by new offer");
        } else if (existing.initiator) {
          if (this.myNodeId < from) return;
          this.dropLink(from, existing, "glare: yielding to smaller node id");
        } else {
          this.dropLink(from, existing, "superseded by newer offer session");
        }
      }
      if (this.links.size >= MAX_TOTAL_LINKS) {
        this.cb.log(`link cap reached; ignoring offer from ${short(from)}`);
        return;
      }
      const link2 = this.newLink(from, session, false, peer.pubkey, event.created_at);
      if (!link2.rxSeen.has(seq)) link2.rxSeen.add(seq);
      link2.pc.ondatachannel = (ev) => this.wireDc(from, link2, ev.channel);
      try {
        await link2.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        if (this.links.get(from) !== link2) return;
        link2.haveRemote = true;
        await this.flushCandidates(link2);
        await link2.pc.setLocalDescription(await link2.pc.createAnswer());
        if (this.links.get(from) !== link2) return;
        await this.sendSignal(from, link2, { kind: "answer", sdp: link2.pc.localDescription.sdp });
        this.cb.log(`answer -> ${short(from)} (session ${session})`);
      } catch (err) {
        this.cb.log(`answer failed for ${short(from)}: ${err.message}`);
        if (this.links.get(from) === link2) {
          this.dropLink(from, link2, "answer failed");
          this.recordFailure(from);
        }
      }
      return;
    }
    const link = this.links.get(from);
    if (!link || link.session !== session) return;
    if (link.rxSeen.has(seq)) return;
    link.rxSeen.add(seq);
    if (payload.kind === "answer") {
      if (!link.initiator || link.haveRemote) return;
      try {
        await link.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        if (this.links.get(from) !== link) return;
        link.haveRemote = true;
        await this.flushCandidates(link);
      } catch (err) {
        this.cb.log(`bad answer from ${short(from)}: ${err.message}`);
        if (this.links.get(from) === link) {
          this.dropLink(from, link, "bad answer");
          this.recordFailure(from);
        }
      }
    } else if (payload.kind === "ice") {
      if (payload.candidate === null) return;
      if (link.haveRemote) {
        try {
          await link.pc.addIceCandidate(payload.candidate);
        } catch {
        }
      } else {
        if (link.pendingCandidates.length < 64) link.pendingCandidates.push(payload.candidate);
      }
    }
  }
  async flushCandidates(link) {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await link.pc.addIceCandidate(candidate);
      } catch {
      }
    }
  }
  wireDc(nodeId, link, dc) {
    link.dc = dc;
    dc.onopen = () => {
      if (this.links.get(nodeId) !== link) return;
      link.state = "open";
      link.lastPongAt = Date.now();
      if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
      this.attempts.delete(nodeId);
      this.clearRetry(nodeId);
      link.pingTimer = setInterval(() => {
        if (this.links.get(nodeId) !== link) return;
        if (Date.now() - link.lastPongAt > PONG_DEADLINE_MS) {
          this.dropLink(nodeId, link, "keepalive timeout");
          this.recordFailure(nodeId);
          this.cb.onPeerClose(nodeId, "keepalive timeout");
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
      if (raw.length > MAX_DC_FRAME_BYTES) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "PING") {
        this.sendOn(link, { t: "PONG", ts: msg.ts });
        return;
      }
      if (msg.t === "PONG") {
        link.lastPongAt = Date.now();
        const rtt = Date.now() - msg.ts;
        if (rtt >= 0 && rtt < 6e4) {
          const peer = this.peers.get(nodeId);
          if (peer) peer.latency_hint = peer.latency_hint ? Math.round(peer.latency_hint * 0.7 + rtt * 0.3) : rtt;
        }
        return;
      }
      this.cb.onMessage(nodeId, msg);
    };
    dc.onclose = () => {
      if (this.links.get(nodeId) !== link) return;
      this.dropLink(nodeId, link, "datachannel closed");
      this.recordFailure(nodeId);
      this.cb.onPeerClose(nodeId, "datachannel closed");
    };
  }
  /** Drop only if `link` is still the current link for `nodeId`. */
  dropLink(nodeId, link, reason) {
    if (this.links.get(nodeId) !== link) return;
    this.links.delete(nodeId);
    if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
    if (link.pingTimer) clearInterval(link.pingTimer);
    try {
      link.dc?.close();
      link.pc.close();
    } catch {
    }
    this.cb.log(`link ${short(nodeId)} dropped (${reason})`);
    setTimeout(() => this.fillSlots(), 0);
  }
  dropLinkById(nodeId, reason) {
    const link = this.links.get(nodeId);
    if (link) this.dropLink(nodeId, link, reason);
  }
  sendOn(link, msg) {
    if (!link.dc || link.dc.readyState !== "open") return false;
    try {
      link.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  send(nodeId, msg) {
    const link = this.links.get(nodeId);
    return link ? this.sendOn(link, msg) : false;
  }
  /** Raw accessor for backpressure-aware bulk transfers (file service). */
  channelOf(nodeId) {
    const dc = this.links.get(nodeId)?.dc;
    return dc?.readyState === "open" ? dc : void 0;
  }
  broadcast(msg, except) {
    let sent = 0;
    for (const [nodeId, link] of this.links) {
      if (nodeId === except) continue;
      if (this.sendOn(link, msg)) sent++;
    }
    return sent;
  }
  connectedNodeIds() {
    const out = [];
    for (const [nodeId, link] of this.links) {
      if (link.state === "open" && link.dc?.readyState === "open") out.push(nodeId);
    }
    return out;
  }
  /**
   * Chained discovery (discovery spec §10.3): adopt a peer we learned about
   * through another node's peer table rather than a relay, and try to connect.
   * As the network grows this is how relay dependence thins out (§1.5).
   */
  introducePeer(entry) {
    if (this.stopped || entry.node_id === this.myNodeId) return false;
    if (this.peers.has(entry.node_id)) return false;
    this.peers.set(entry.node_id, {
      node_id: entry.node_id,
      pubkey: entry.pubkey,
      nickname: entry.nickname,
      last_seen: entry.last_seen,
      rights: [],
      capabilities: entry.capabilities,
      latency_hint: entry.latency_hint
    });
    this.maybeConnect(entry.node_id);
    return true;
  }
  /** Snapshot for the peer table we hand to newly connected peers (§10.1). */
  peerTable(myEntry) {
    const open = new Set(this.connectedNodeIds());
    const rows = [myEntry];
    for (const p of this.peers.values()) {
      if (!open.has(p.node_id)) continue;
      rows.push({
        node_id: p.node_id,
        pubkey: p.pubkey,
        last_seen: p.last_seen,
        capabilities: p.capabilities ?? ["chat", "store"],
        latency_hint: p.latency_hint,
        nickname: p.nickname
      });
    }
    return rows;
  }
  peerInfo(nodeId) {
    return this.peers.get(nodeId);
  }
  /** Forcibly remove a peer (e.g. after its invite was revoked). */
  removePeer(nodeId) {
    this.dropLinkById(nodeId, "removed");
    this.peers.delete(nodeId);
    this.clearRetry(nodeId);
    this.attempts.delete(nodeId);
    this.cb.onPeerClose(nodeId);
  }
  /** Drop peers whose heartbeat lapsed and who have no open channel. */
  prune(now, ttl) {
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
  shutdown() {
    this.stopped = true;
    for (const [nodeId, link] of [...this.links]) this.dropLink(nodeId, link, "shutdown");
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }
};
function short(id) {
  return id.slice(0, 8);
}

// src/client/files.ts
var CHUNK_BYTES = 16 * 1024;
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var BUFFER_HIGH = 1 * 1024 * 1024;
var BUFFER_LOW = 256 * 1024;
var IDLE_TIMEOUT_MS = 2e4;
var FileService = class {
  constructor(store2, mesh, log2, hooks = {}) {
    this.store = store2;
    this.mesh = mesh;
    this.log = log2;
    this.hooks = hooks;
  }
  /** cid -> in-flight download */
  incoming = /* @__PURE__ */ new Map();
  async cidOfBytes(bytes) {
    return `cid:sha256:${await sha256Hex(bytes)}`;
  }
  /** Store a local file and return its metadata for announcement. */
  async shareFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`\u30D5\u30A1\u30A4\u30EB\u304C\u5927\u304D\u3059\u304E\u307E\u3059 (\u4E0A\u9650 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB)`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cid = await this.cidOfBytes(bytes);
    await this.store.put("blobs", cid, bytes.buffer);
    return { cid, name: file.name, size: bytes.length, mime: file.type || "application/octet-stream" };
  }
  async localBlob(cid) {
    const buf = await this.store.get("blobs", cid);
    return buf ? new Uint8Array(buf) : void 0;
  }
  /**
   * Fetch a blob: local cache first, then each connected peer in turn until
   * one delivers bytes that hash to the CID.
   */
  async fetchBlob(cid) {
    const local = await this.localBlob(cid);
    if (local) return local;
    let peers = this.mesh.connectedNodeIds();
    if (this.hooks.rankPeers) peers = this.hooks.rankPeers(peers);
    if (peers.length === 0) throw new Error("\u63A5\u7D9A\u4E2D\u306E\u30D4\u30A2\u304C\u3044\u307E\u305B\u3093");
    let lastError = "no provider";
    for (const peer of peers) {
      try {
        const bytes = await this.requestFrom(peer, cid);
        await this.store.put("blobs", cid, bytes.buffer);
        this.hooks.onOutcome?.(peer, true);
        return bytes;
      } catch (err) {
        lastError = err.message;
        this.hooks.onOutcome?.(peer, false);
      }
    }
    throw new Error(`\u53D6\u5F97\u5931\u6557: ${lastError}`);
  }
  requestFrom(peer, cid) {
    if (this.incoming.has(cid)) {
      return Promise.reject(new Error("already fetching"));
    }
    return new Promise((resolve, reject) => {
      const transfer = {
        cid,
        peer,
        chunks: [],
        received: 0,
        total: -1,
        size: 0,
        bytesSeen: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.incoming.delete(cid);
          reject(new Error("\u8EE2\u9001\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8 (\u7121\u5FDC\u7B54)"));
        }, IDLE_TIMEOUT_MS)
      };
      this.incoming.set(cid, transfer);
      if (!this.mesh.send(peer, { t: "BLOB_REQ", cid })) {
        clearTimeout(transfer.timer);
        this.incoming.delete(cid);
        reject(new Error("\u9001\u4FE1\u5931\u6557"));
      }
    }).finally(() => {
      const transfer = this.incoming.get(cid);
      if (transfer) {
        clearTimeout(transfer.timer);
        this.incoming.delete(cid);
      }
    });
  }
  touch(transfer) {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
      this.incoming.delete(transfer.cid);
      transfer.reject(new Error("\u8EE2\u9001\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8 (\u7121\u5FDC\u7B54)"));
    }, IDLE_TIMEOUT_MS);
  }
  /** Handle file-transfer DataChannel messages. Returns true when consumed. */
  async handleMessage(from, msg) {
    switch (msg.t) {
      case "BLOB_REQ": {
        await this.serve(from, msg.cid);
        return true;
      }
      case "BLOB_META": {
        const transfer = this.incoming.get(msg.cid);
        if (!transfer || transfer.peer !== from) return true;
        this.touch(transfer);
        if (typeof msg.size !== "number" || typeof msg.chunks !== "number" || msg.size < 0 || msg.size > MAX_FILE_BYTES || msg.chunks < 0 || msg.chunks > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)) {
          transfer.reject(new Error("\u4E0D\u6B63\u306A\u30E1\u30BF\u30C7\u30FC\u30BF"));
          return true;
        }
        transfer.total = msg.chunks;
        transfer.size = msg.size;
        transfer.chunks = new Array(msg.chunks);
        if (msg.chunks === 0) this.finish(transfer);
        return true;
      }
      case "BLOB_CHUNK": {
        const transfer = this.incoming.get(msg.cid);
        if (!transfer || transfer.peer !== from || transfer.total < 0) return true;
        if (typeof msg.idx !== "number" || msg.idx < 0 || msg.idx >= transfer.total) return true;
        if (transfer.chunks[msg.idx]) return true;
        this.touch(transfer);
        let bytes;
        try {
          bytes = base64UrlDecode(msg.data);
        } catch {
          transfer.reject(new Error("\u30C1\u30E3\u30F3\u30AF\u306E\u5FA9\u53F7\u5931\u6557"));
          return true;
        }
        if (bytes.length > CHUNK_BYTES || transfer.bytesSeen + bytes.length > transfer.size) {
          transfer.reject(new Error("\u30C1\u30E3\u30F3\u30AF\u30B5\u30A4\u30BA\u8D85\u904E"));
          return true;
        }
        transfer.bytesSeen += bytes.length;
        transfer.chunks[msg.idx] = bytes;
        transfer.received += 1;
        if (transfer.received === transfer.total) await this.finish(transfer);
        return true;
      }
      case "BLOB_ERR": {
        const transfer = this.incoming.get(msg.cid);
        if (transfer && transfer.peer === from) transfer.reject(new Error(msg.reason || "peer error"));
        return true;
      }
      default:
        return false;
    }
  }
  async finish(transfer) {
    let size = 0;
    for (const chunk of transfer.chunks) size += chunk?.length ?? 0;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      if (!chunk) {
        transfer.reject(new Error("\u6B20\u640D\u30C1\u30E3\u30F3\u30AF"));
        return;
      }
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const cid = await this.cidOfBytes(bytes);
    if (cid !== transfer.cid) {
      transfer.reject(new Error("CID\u4E0D\u4E00\u81F4 (\u6539\u3056\u3093\u307E\u305F\u306F\u7834\u640D)"));
      return;
    }
    transfer.resolve(bytes);
  }
  /** Stream a local blob to a requesting peer with backpressure. */
  async serve(to, cid) {
    if (typeof cid !== "string" || !/^cid:sha256:[0-9a-f]{64}$/.test(cid)) return;
    const bytes = await this.localBlob(cid);
    if (!bytes) {
      this.mesh.send(to, { t: "BLOB_ERR", cid, reason: "not found" });
      return;
    }
    const total = Math.ceil(bytes.length / CHUNK_BYTES);
    this.mesh.send(to, { t: "BLOB_META", cid, size: bytes.length, chunks: total });
    const dc = this.mesh.channelOf(to);
    if (!dc) return;
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    for (let idx = 0; idx < total; idx++) {
      if (dc.readyState !== "open") return;
      if (dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise((resolve) => {
          const onLow = () => {
            dc.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          dc.addEventListener("bufferedamountlow", onLow);
          setTimeout(onLow, 5e3);
        });
      }
      const chunk = bytes.subarray(idx * CHUNK_BYTES, (idx + 1) * CHUNK_BYTES);
      if (!this.mesh.send(to, { t: "BLOB_CHUNK", cid, idx, data: base64UrlEncode(chunk) })) return;
    }
    this.log(`blob ${cid.slice(11, 19)}\u2026 (${bytes.length}B) served to ${to.slice(0, 8)}`);
  }
};

// src/client/conversation.ts
var ANTI_ENTROPY_MS = 6e4;
var MAX_ENTRIES_PER_DELTA = 512;
var MY_CAPABILITIES = ["chat", "store", "nameservice"];
var RELAY_INDEPENDENCE_AT = 3;
var Conversation = class {
  constructor(spec, id, deps2) {
    this.id = id;
    this.deps = deps2;
    this.spec = spec;
    this.log = new GSetLog(`${id.myNodeId}`);
  }
  spec;
  unread = 0;
  lastTs = 0;
  pool;
  mesh;
  files;
  log;
  members = /* @__PURE__ */ new Map();
  timers = [];
  cachedJoin;
  dmKey;
  myRights = [];
  started = false;
  nicknames = /* @__PURE__ */ new Map();
  peerNodeId;
  /** discovery candidates keyed by node id (discovery spec §8) */
  candidates = /* @__PURE__ */ new Map();
  /** which relays reported each candidate — feeds the diversity score */
  candidateRelays = /* @__PURE__ */ new Map();
  nameService;
  nsVersion = 0;
  get networkId() {
    return this.spec.network_id;
  }
  get kind() {
    return this.spec.kind;
  }
  get title() {
    return this.spec.title;
  }
  /** Live display title: DMs resolve to @<peer nickname> once we learn it. */
  displayTitle() {
    if (this.spec.kind === "dm" && this.peerNodeId) {
      const nick = this.nicknames.get(this.peerNodeId) ?? this.members.get(this.peerNodeId)?.nickname;
      if (nick) return `@${nick}`;
    }
    return this.spec.title;
  }
  async start() {
    if (this.started) return;
    this.started = true;
    const epochKey = `epoch/${this.networkId}`;
    let epoch = await this.deps.store.get("kv", epochKey);
    if (!epoch) {
      epoch = randHex(4);
      await this.deps.store.put("kv", epochKey, epoch);
    }
    const replica = `${this.id.myNodeId}.${epoch}`;
    this.log = GSetLog.fromJSON(replica, await this.deps.store.get("crdt", `chat/${this.networkId}`) ?? []);
    for (const m of await this.deps.store.get("members", this.networkId) ?? []) {
      this.members.set(m.node_id, m);
    }
    if (this.spec.kind === "dm" && this.spec.peerPubkey) {
      this.dmKey = await deriveDmKey(this.id.ecdhKey, this.spec.peerPubkey, this.id.pubkeyHex);
      this.peerNodeId = await nodeIdFromPubkey(this.spec.peerPubkey);
    }
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
        this.mesh?.send(peer.node_id, { t: "PEER_TABLE", peers: this.mesh.peerTable(this.myPeerEntry()) });
        const records = this.nameService?.all() ?? [];
        if (records.length) this.mesh?.send(peer.node_id, { t: "NS", records: records.slice(0, 64) });
        void this.persistPeerTable();
        this.deps.onChange(this);
      },
      onPeerClose: (nodeId, reason) => {
        if (reason === "keepalive timeout") this.deps.reputation.record(nodeId, "keepalive-timeout");
        else if (reason?.startsWith("pc ")) this.deps.reputation.record(nodeId, "pc-failed");
        this.deps.onChange(this);
      },
      onMessage: (from, msg) => void this.handleDc(from, msg),
      log: this.deps.log
    });
    this.files = new FileService(this.deps.store, this.mesh, this.deps.log, {
      rankPeers: (ids) => this.deps.reputation.rank(ids),
      onOutcome: (peer, ok) => this.deps.reputation.record(peer, ok ? "file-served" : "file-failed")
    });
    this.pool = new RelayPool({
      urls: this.spec.relays,
      filter: { network_id: this.networkId, target: this.id.myNodeId },
      onEvent: (event, relayUrl) => void this.handleRelayEvent(event, relayUrl),
      // every delivery, including the same event from a second relay: this is
      // how the relay-diversity term of the score gets real data (§8.3)
      onSighting: (event, relayUrl) => {
        if (event.node_id === this.id.myNodeId) return;
        if (event.type !== "JOIN" && event.type !== "HEARTBEAT") return;
        const relays2 = this.candidateRelays.get(event.node_id) ?? /* @__PURE__ */ new Set();
        const before = relays2.size;
        relays2.add(relayUrl);
        this.candidateRelays.set(event.node_id, relays2);
        const candidate = this.candidates.get(event.node_id);
        if (candidate && relays2.size !== before) {
          candidate.relay_count = relays2.size;
          this.applyPriority();
        }
      },
      onStatus: (_url, connected) => {
        this.deps.onChange(this);
        if (connected) void this.announce();
      }
    });
    this.pool.start();
    this.nameService = new NameServiceStore(this.networkId);
    this.nameService.load(await this.deps.store.get("ns", this.networkId) ?? []);
    await this.loadPeerTable();
    this.timers.push(
      window.setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL * 1e3),
      window.setInterval(() => void this.publishManifest(), 5 * 6e4),
      window.setInterval(() => void this.persistPeerTable(), 6e4),
      window.setInterval(() => void this.announce(), 24e4),
      window.setInterval(() => {
        this.mesh?.prune(nowSeconds(), HEARTBEAT_TTL * 2);
        this.deps.onChange(this);
      }, 2e4),
      window.setInterval(() => {
        const peers = this.mesh?.connectedNodeIds() ?? [];
        if (peers.length) {
          const peer = peers[Math.floor(Math.random() * peers.length)];
          this.mesh?.send(peer, { t: "SYNC_REQ", chat_vv: this.log.versionVector(), profile_lamport: 0 });
        }
      }, ANTI_ENTROPY_MS)
    );
    this.deps.log(`conversation started: ${this.title}`);
  }
  async stop() {
    if (this.pool && this.spec.relays.length) {
      try {
        this.pool.publish(await createLeave(this.networkId, this.id.nodeKeys));
      } catch {
      }
    }
    this.mesh?.shutdown();
    this.pool?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
  }
  // --- discovery / relay ---
  async announce() {
    if (!this.pool) return;
    const now = nowSeconds();
    if (!this.cachedJoin || this.cachedJoin.expires_at - now <= JOIN_TTL / 3) {
      this.cachedJoin = this.spec.kind === "invite" ? await createJoin(this.networkId, this.id.nodeKeys, this.spec.inviteChain ?? [], this.deps.nickname()) : await createJoin(this.networkId, this.id.nodeKeys, [], {
        open: true,
        room: this.spec.room,
        nickname: this.deps.nickname()
      });
    }
    this.pool.publish(this.cachedJoin);
  }
  hbTick = 0;
  async heartbeat() {
    if (!this.pool) return;
    this.hbTick += 1;
    const healthy = (this.mesh?.connectedNodeIds().length ?? 0) >= RELAY_INDEPENDENCE_AT;
    if (healthy && this.hbTick % 2 !== 0) return;
    this.pool.publish(await createHeartbeat(this.networkId, this.id.nodeKeys));
  }
  /** True when the mesh is self-sustaining enough to not need the relay for
   * ongoing discovery (§1.5). Surfaced in the UI. */
  relayIndependent() {
    return (this.mesh?.connectedNodeIds().length ?? 0) >= RELAY_INDEPENDENCE_AT;
  }
  async handleRelayEvent(event, relayUrl) {
    if (!this.mesh) return;
    if (event.node_id !== this.id.myNodeId && this.deps.reputation.isBanned(event.node_id)) return;
    if (event.type === "JOIN" && event.node_id !== this.id.myNodeId) {
      const join = event;
      const ok = await this.acceptMembership(event.pubkey, join.body.invite_chain, join.body.nickname);
      if (!ok) return;
    }
    if (event.node_id !== this.id.myNodeId && (event.type === "JOIN" || event.type === "HEARTBEAT")) {
      this.observeCandidate(event, relayUrl);
    }
    if (event.type === "LEAVE") {
      this.candidates.delete(event.node_id);
      this.candidateRelays.delete(event.node_id);
    }
    if (event.type === "MANIFEST") {
      await this.mergeManifest(event.body.records ?? []);
    }
    await this.mesh.handleDiscoveryEvent(event);
    this.deps.onChange(this);
  }
  /** Fold a JOIN/HEARTBEAT into this node's candidate record (§8.3 Step 4). */
  observeCandidate(event, relayUrl) {
    const existing = this.candidates.get(event.node_id);
    let relays2 = this.candidateRelays.get(event.node_id);
    if (!relays2) {
      relays2 = /* @__PURE__ */ new Set();
      this.candidateRelays.set(event.node_id, relays2);
    }
    if (relayUrl) relays2.add(relayUrl);
    const chain = event.type === "JOIN" ? event.body.invite_chain ?? [] : [];
    const candidate = {
      node_id: event.node_id,
      pubkey: event.pubkey,
      join_at: event.type === "JOIN" ? Math.max(existing?.join_at ?? 0, event.created_at) : existing?.join_at ?? 0,
      heartbeat_at: event.type === "HEARTBEAT" ? Math.max(existing?.heartbeat_at ?? 0, event.created_at) : existing?.heartbeat_at ?? 0,
      relay_count: relays2.size,
      latency_ms: this.mesh?.peerInfo(event.node_id)?.latency_hint ?? existing?.latency_ms,
      // §8.3: a candidate whose chain shares our root of trust ranks higher
      invite_match: this.spec.kind === "invite" ? this.sharesInviteRoot(chain) : true,
      capabilities: existing?.capabilities
    };
    this.candidates.set(event.node_id, candidate);
    this.applyPriority();
  }
  /** Push the scored order into the mesh so connections are attempted
   * best-first and freed slots go to the next-best candidate (§8.3, §12.2). */
  applyPriority() {
    this.mesh?.setPriority(this.rankedCandidates().map((c) => c.node_id));
  }
  sharesInviteRoot(chain) {
    const ourRoot = this.spec.inviteChain?.[0]?.issuer_pubkey;
    return !!ourRoot && chain[0]?.issuer_pubkey === ourRoot;
  }
  /**
   * Candidates ranked best-first (§8.3 Steps 4-5). The UI and the connection
   * logic both read this, so "who do we try first" is one deterministic policy.
   */
  rankedCandidates(now = nowSeconds()) {
    const live = [...this.candidates.values()].filter((c) => isViable(c, now));
    return rankCandidates(live, now);
  }
  async acceptMembership(pubkey, chain, nickname2) {
    let rights;
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
    const record = {
      node_id: nodeId,
      pubkey,
      nickname: nickname2 ?? existing?.nickname,
      rights,
      invite_chain: chain,
      verified_at: nowSeconds()
    };
    this.members.set(nodeId, record);
    if (nickname2) this.nicknames.set(nodeId, nickname2);
    await this.persistMembers();
    return true;
  }
  // --- DataChannel sync ---
  sendHello(to) {
    this.mesh?.send(to, {
      t: "HELLO",
      node_id: this.id.myNodeId,
      pubkey: this.id.pubkeyHex,
      nickname: this.deps.nickname(),
      chain: this.spec.inviteChain ?? [],
      peers: [...this.mesh?.peers.values() ?? []]
    });
  }
  async handleDc(from, msg) {
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
        if (await nodeIdFromPubkey(msg.pubkey) !== from) return;
        await this.acceptMembership(msg.pubkey, msg.chain ?? [], msg.nickname);
        if (msg.nickname) this.nicknames.set(from, msg.nickname);
        this.mesh.send(from, { t: "PEER_TABLE", peers: this.mesh.peerTable(this.myPeerEntry()) });
        this.deps.onChange(this);
        break;
      }
      case "PEER_TABLE": {
        let learned = 0;
        for (const entry of (msg.peers ?? []).slice(0, 64)) {
          if (!entry || typeof entry.node_id !== "string" || typeof entry.pubkey !== "string") continue;
          if (entry.node_id === this.id.myNodeId) continue;
          if (await nodeIdFromPubkey(entry.pubkey) !== entry.node_id) continue;
          if (this.deps.reputation.isBanned(entry.node_id)) continue;
          if (this.mesh.introducePeer(entry)) {
            learned++;
            this.candidates.set(entry.node_id, {
              node_id: entry.node_id,
              pubkey: entry.pubkey,
              join_at: entry.last_seen,
              heartbeat_at: entry.last_seen,
              relay_count: 0,
              latency_ms: entry.latency_hint,
              invite_match: this.spec.kind !== "invite",
              capabilities: entry.capabilities,
              via_peer_table: true
            });
          }
        }
        if (learned) {
          this.applyPriority();
          this.deps.log(`peer table from ${from.slice(0, 8)}: ${learned} new peer(s) (chained discovery)`);
          await this.persistPeerTable();
          this.deps.onChange(this);
        }
        break;
      }
      case "NS": {
        await this.mergeManifest(msg.records ?? []);
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
  async acceptEntries(from, entries) {
    const batch = (entries ?? []).slice(0, MAX_ENTRIES_PER_DELTA);
    const good = [];
    for (const entry of batch) {
      if (typeof entry?.id !== "string" || entry.kind !== "chat" && entry.kind !== "file") continue;
      if (!await verifyLogEntry(entry)) {
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
  bump(added) {
    for (const e of added) {
      if (replicaNodeId(e.origin) !== this.id.myNodeId) this.unread += 1;
      if (e.ts > this.lastTs) this.lastTs = e.ts;
    }
  }
  // --- actions ---
  async sendChat(text) {
    let data;
    if (this.spec.kind === "dm") {
      if (!this.dmKey) throw new Error("DM\u9375\u304C\u3042\u308A\u307E\u305B\u3093");
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
  async shareFile(file) {
    if (!this.files) return;
    const meta = await this.files.shareFile(file);
    const entry = this.log.append("file", meta, nowSeconds());
    await signLogEntry(this.id.nodeKeys.privateKey, this.id.pubkeyHex, entry);
    await this.persistChat();
    this.mesh?.broadcast({ t: "CHAT_DELTA", entries: [entry] });
    this.deps.onChange(this);
  }
  async fetchBlob(meta) {
    if (!this.files) throw new Error("not started");
    return this.files.fetchBlob(meta.cid);
  }
  // --- views ---
  async messages() {
    const out = [];
    for (const entry of this.log.ordered()) {
      if (entry.kind !== "chat" && entry.kind !== "file") continue;
      const origin = replicaNodeId(entry.origin);
      const mine = origin === this.id.myNodeId;
      if (entry.kind === "file") {
        out.push({ id: entry.id, origin, mine, kind: "file", file: entry.data, ts: entry.ts });
      } else {
        let text;
        const data = entry.data;
        if (data.enc && this.dmKey) {
          text = await dmDecrypt(this.dmKey, data.enc) ?? "\u{1F512}(\u5FA9\u53F7\u3067\u304D\u307E\u305B\u3093)";
        } else {
          text = String(data.text ?? "");
        }
        out.push({ id: entry.id, origin, mine, kind: "chat", text, ts: entry.ts });
      }
    }
    return out;
  }
  memberViews() {
    const connected = new Set(this.mesh?.connectedNodeIds() ?? []);
    const now = nowSeconds();
    return [...this.mesh?.peers.values() ?? []].sort((a, b) => a.node_id.localeCompare(b.node_id)).map((p) => ({
      node_id: p.node_id,
      nickname: this.nicknameOf(p.node_id),
      connected: connected.has(p.node_id),
      seen: now - p.last_seen <= HEARTBEAT_TTL * 2,
      score: Math.round(this.deps.reputation.scoreOf(p.node_id)),
      banned: this.deps.reputation.isBanned(p.node_id),
      pubkey: p.pubkey
    }));
  }
  nicknameOf(nodeId) {
    if (nodeId === this.id.myNodeId) return this.deps.nickname();
    return this.nicknames.get(nodeId) ?? this.members.get(nodeId)?.nickname ?? this.mesh?.peers.get(nodeId)?.nickname ?? nodeId.slice(0, 8);
  }
  connectedCount() {
    return this.mesh?.connectedNodeIds().length ?? 0;
  }
  relaysUp() {
    return this.pool?.connectedCount() ?? 0;
  }
  hasRelays() {
    return this.spec.relays.length > 0;
  }
  canChat() {
    return this.myRights.includes("chat");
  }
  clearUnread() {
    this.unread = 0;
  }
  // ---- Peer table & Name Service (discovery spec §10, §11) ----
  /** Our own row for the peer table we hand to peers (§10.1). */
  myPeerEntry() {
    return {
      node_id: this.id.myNodeId,
      pubkey: this.id.pubkeyHex,
      last_seen: nowSeconds(),
      capabilities: MY_CAPABILITIES,
      nickname: this.deps.nickname()
    };
  }
  /** §13: the peer table survives reloads, so a returning node has candidates
   * before any relay answers. */
  async persistPeerTable() {
    if (!this.mesh) return;
    await this.deps.store.put("peers", `table/${this.networkId}`, this.mesh.peerTable(this.myPeerEntry()));
  }
  async loadPeerTable() {
    const rows = await this.deps.store.get("peers", `table/${this.networkId}`) ?? [];
    const now = nowSeconds();
    for (const entry of rows) {
      if (!entry?.node_id || entry.node_id === this.id.myNodeId) continue;
      this.mesh?.introducePeer(entry);
      this.candidates.set(entry.node_id, {
        node_id: entry.node_id,
        pubkey: entry.pubkey,
        join_at: Math.min(entry.last_seen, now),
        heartbeat_at: 0,
        relay_count: 0,
        latency_ms: entry.latency_hint,
        invite_match: this.spec.kind !== "invite",
        capabilities: entry.capabilities,
        via_peer_table: true
      });
    }
    if (rows.length) {
      this.applyPriority();
      this.deps.log(`restored ${rows.length} cached peer(s) for ${this.title}`);
    }
  }
  /** Merge signed Name Service records (§11.3) from a MANIFEST or a peer. */
  async mergeManifest(records) {
    if (!this.nameService) return;
    let changed = false;
    for (const record of records.slice(0, 128)) {
      if (await this.nameService.merge(record)) changed = true;
    }
    if (changed) {
      await this.deps.store.put("ns", this.networkId, this.nameService.all());
      this.deps.onChange(this);
    }
  }
  /** Announce ourselves in the Name Service and publish a MANIFEST (§11). */
  async publishManifest() {
    if (!this.pool || !this.nameService) return;
    this.nsVersion += 1;
    const nodeRecord = await createNameRecord(
      this.networkId,
      this.id.nodeKeys,
      `node/${this.id.myNodeId}`,
      { kind: "node", node_id: this.id.myNodeId, capabilities: MY_CAPABILITIES, nickname: this.deps.nickname() },
      this.nsVersion,
      600
    );
    await this.nameService.merge(nodeRecord);
    const serving = [this.id.myNodeId, ...this.mesh?.connectedNodeIds() ?? []].sort();
    const chatRecord = await createNameRecord(
      this.networkId,
      this.id.nodeKeys,
      `service/chat/${this.id.myNodeId}`,
      { kind: "node-set", nodes: serving },
      this.nsVersion,
      600
    );
    await this.nameService.merge(chatRecord);
    await this.deps.store.put("ns", this.networkId, this.nameService.all());
    this.pool.publish(
      await createManifest(this.networkId, this.id.nodeKeys, {
        relays: this.spec.relays,
        records: this.nameService.all().slice(0, 64)
      })
    );
  }
  /** §11.4: resolve a name from the replicated record set (DNS-like). */
  resolve(name) {
    return this.nameService?.resolve(name);
  }
  /** Nodes advertising a capability, via the Name Service (§11.4). */
  serviceNodes(capability) {
    const out = /* @__PURE__ */ new Set();
    for (const record of this.nameService?.all() ?? []) {
      const value = record.value;
      if (value?.kind === "node" && value.capabilities?.includes(capability) && value.node_id) out.add(value.node_id);
      if (value?.kind === "node-set" && capability === "chat") for (const n of value.nodes ?? []) out.add(n);
    }
    return [...out];
  }
  async persistChat() {
    await this.deps.store.put("crdt", `chat/${this.networkId}`, this.log.toJSON());
  }
  async persistMembers() {
    await this.deps.store.put("members", this.networkId, [...this.members.values()]);
  }
};
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

// src/client/main.ts
var store;
var reputation = new Reputation();
var identity;
var nickname = "";
var relays = [];
var conversations = /* @__PURE__ */ new Map();
var activeId;
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
var escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
var short2 = (id) => id ? `${id.slice(0, 10)}\u2026` : "";
function humanSize(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}
var AVATAR_COLORS = ["#6d5efc", "#e0567a", "#20a4a4", "#e0952b", "#3b82f6", "#8b5cf6", "#16a34a", "#db2777"];
function avatarColor(id) {
  let h = 0;
  for (const ch of id) h = h * 31 + ch.charCodeAt(0) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
var initial = (name) => (name.trim()[0] ?? "?").toUpperCase();
function avatarHtml(id, name, cls = "avatar") {
  return `<span class="${cls}" style="background:${avatarColor(id)}">${escapeHtml(initial(name))}</span>`;
}
function toast(message, kind = "info") {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 4e3);
}
function log(line) {
  const el = document.getElementById("log");
  if (!el) return;
  el.textContent = `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${line}
${el.textContent ?? ""}`.slice(0, 12e3);
}
async function copy(text, okMsg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "ok");
  } catch {
    toast("\u30B3\u30D4\u30FC\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F", "error");
  }
}
function urlRelay() {
  const q = new URLSearchParams(location.search).get("relay");
  const h = /[#&]relay=([^&]+)/.exec(location.hash);
  const raw = q ?? (h ? decodeURIComponent(h[1]) : void 0);
  return raw && /^wss?:\/\//.test(raw) ? raw : void 0;
}
function defaultRelays() {
  const fromUrl = urlRelay();
  if (fromUrl) return [fromUrl];
  if (location.protocol.startsWith("http")) {
    return [`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`];
  }
  return [];
}
function autoNickname() {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return `guest-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function deps() {
  return {
    store,
    reputation,
    nickname: () => nickname,
    onChange: (c) => {
      if (c.networkId === activeId) void renderChat();
      renderConvList();
    },
    onActivity: (c) => {
      if (c.networkId !== activeId) renderConvList();
    },
    log
  };
}
async function persistConversations() {
  const list = [...conversations.values()].filter((c) => c.kind !== "invite").map((c) => ({
    network_id: c.networkId,
    kind: c.kind,
    room: c.spec.room ?? "",
    title: c.spec.title,
    peerPubkey: c.spec.peerPubkey
  }));
  await store.put("kv", "conversations", list);
}
async function addConversation(spec, activate = true) {
  let conv = conversations.get(spec.network_id);
  if (!conv) {
    conv = new Conversation(spec, identity, deps());
    conversations.set(spec.network_id, conv);
    await conv.start();
    await persistConversations();
  }
  if (activate) setActive(spec.network_id);
  renderConvList();
  return conv;
}
async function openChannel(name) {
  const room = normalizeRoom(name);
  if (!room) throw new Error("\u30C1\u30E3\u30F3\u30CD\u30EB\u540D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
  const networkId = await openNetworkId(room);
  await addConversation({ network_id: networkId, kind: "channel", room, title: `#${room}`, relays });
}
async function openDm(peerPubkey) {
  const pk = peerPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{130}$/.test(pk)) throw new Error("\u30E6\u30FC\u30B6\u30FCID\u306E\u5F62\u5F0F\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (pk === identity.pubkeyHex) throw new Error("\u81EA\u5206\u81EA\u8EAB\u3068\u306FDM\u3067\u304D\u307E\u305B\u3093");
  const networkId = await dmNetworkId(identity.pubkeyHex, pk);
  const room = dmRoom(identity.pubkeyHex, pk);
  await addConversation({
    network_id: networkId,
    kind: "dm",
    room,
    title: `@${short2(pk)}`,
    relays,
    peerPubkey: pk
  });
}
function setActive(networkId) {
  activeId = networkId;
  conversations.get(networkId)?.clearUnread();
  document.body.classList.add("chat-open");
  $("chat").classList.remove("empty-state");
  $("chat-empty").hidden = true;
  $("chat-view").hidden = false;
  void renderChat();
  renderConvList();
}
function renderConvList() {
  const list = $("conv-list");
  const items = [...conversations.values()].sort((a, b) => b.lastTs - a.lastTs);
  list.innerHTML = items.map((c) => {
    const active = c.networkId === activeId;
    const unread = c.unread > 0 ? `<span class="unread">${c.unread}</span>` : "";
    const sub = c.connectedCount() > 0 ? `${c.connectedCount()}\u4EBA\u63A5\u7D9A\u4E2D` : "\u63A2\u7D22\u4E2D\u2026";
    return `<button class="conv-item ${active ? "active" : ""}" data-id="${c.networkId}">
          ${avatarHtml(c.networkId, c.displayTitle().replace(/^[#@]/, ""))}
          <div class="conv-main"><div class="conv-title">${escapeHtml(c.displayTitle())}</div><div class="conv-sub">${sub}</div></div>
          ${unread}
        </button>`;
  }).join("") || `<div class="muted small" style="padding:16px">\u4F1A\u8A71\u304C\u3042\u308A\u307E\u305B\u3093</div>`;
  for (const btn of list.querySelectorAll(".conv-item")) {
    btn.onclick = () => setActive(btn.dataset["id"]);
  }
  $("me-name").textContent = nickname;
  $("me-avatar").style.background = avatarColor(identity?.myNodeId ?? "");
  $("me-avatar").textContent = initial(nickname);
}
async function renderChat() {
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
    ctext.textContent = conv.kind === "dm" ? "\u63A5\u7D9A\u4E2D\u30FB\u6697\u53F7\u5316" : `${connected}\u4EBA\u3068\u63A5\u7D9A\u4E2D`;
  } else if (conv.relaysUp() > 0) {
    dot.classList.add("warn");
    ctext.textContent = "\u76F8\u624B\u3092\u63A2\u7D22\u4E2D\u2026";
  } else if (!conv.hasRelays()) {
    dot.classList.add("ng");
    ctext.textContent = "Relay\u672A\u8A2D\u5B9A";
  } else {
    dot.classList.add("ng");
    ctext.textContent = "Relay\u306B\u63A5\u7D9A\u4E2D\u2026";
  }
  const box = $("chat-box");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  const msgs = await conv.messages();
  box.innerHTML = msgs.map((m) => {
    const time = new Date(m.ts * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = conv.nicknameOf(m.origin);
    let inner;
    if (m.kind === "file" && m.file) {
      const busy2 = downloading.has(m.file.cid);
      inner = `<span class="file-chip" data-cid="${escapeHtml(m.file.cid)}">\u{1F4C4}
            <span class="fname">${escapeHtml(m.file.name)}</span>
            <span class="muted">${humanSize(m.file.size)}</span>
            <button class="btn small file-dl" data-cid="${escapeHtml(m.file.cid)}" ${busy2 ? "disabled" : ""}>${busy2 ? "\u53D6\u5F97\u4E2D" : "\u53D6\u5F97"}</button></span>`;
    } else {
      inner = `<div class="bubble">${escapeHtml(m.text ?? "")}</div>`;
    }
    return `<div class="msg ${m.mine ? "me" : ""}">${avatarHtml(m.origin, who)}
          <div class="bubble-wrap"><div class="who">${escapeHtml(who)}</div>${inner}<div class="time">${time}</div></div></div>`;
  }).join("") || `<div class="empty">${conv.kind === "dm" ? "\u6697\u53F7\u5316\u3055\u308C\u305FDM\u3067\u3059\u3002\u6700\u521D\u306E\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u9001\u308A\u307E\u3057\u3087\u3046 \u{1F512}" : "\u307E\u3060\u30E1\u30C3\u30BB\u30FC\u30B8\u306F\u3042\u308A\u307E\u305B\u3093 \u{1F44B}"}</div>`;
  for (const b of box.querySelectorAll(".file-dl")) {
    b.onclick = () => {
      const cid = b.dataset["cid"];
      const m = msgs.find((x) => x.file?.cid === cid);
      if (m?.file) void downloadFile(conv, m.file);
    };
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function renderMembers() {
  const conv = activeId ? conversations.get(activeId) : void 0;
  const sec = $("members-sec");
  if (!conv || conv.kind === "dm") {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  const members = conv.memberViews();
  $("peer-count").textContent = String(members.filter((m) => m.connected).length);
  $("member-list").innerHTML = members.map((m) => {
    const state = m.connected ? "\u63A5\u7D9A\u4E2D" : m.seen ? "\u767A\u898B\u6E08\u307F" : "\u30AA\u30D5\u30E9\u30A4\u30F3";
    const trust = m.banned ? `<span class="badge ng-text">\u906E\u65AD</span>` : m.score !== 0 ? `<span class="badge">\u4FE1\u983C ${m.score}</span>` : "";
    return `<li>${avatarHtml(m.node_id, m.nickname)}
          <div class="m-main"><div class="m-name">${escapeHtml(m.nickname)}</div><div class="m-sub">${state} ${trust}</div></div>
          <button class="btn small dm-btn" data-pk="${escapeHtml(m.pubkey)}">DM</button></li>`;
  }).join("") || `<li class="muted">\u307E\u3060\u4ED6\u306E\u53C2\u52A0\u8005\u304C\u3044\u307E\u305B\u3093</li>`;
  for (const b of $("member-list").querySelectorAll(".dm-btn")) {
    b.onclick = () => {
      openDrawer(false);
      void openDm(b.dataset["pk"]).catch((e) => toast(e.message, "error"));
    };
  }
}
var downloading = /* @__PURE__ */ new Set();
async function downloadFile(conv, meta) {
  if (downloading.has(meta.cid)) return;
  downloading.add(meta.cid);
  void renderChat();
  try {
    const bytes = await conv.fetchBlob(meta);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: meta.mime || "application/octet-stream" }));
    a.download = meta.name || "file";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${meta.name} \u3092\u53D6\u5F97\u3057\u307E\u3057\u305F\uFF08CID\u691C\u8A3C\u6E08\u307F\uFF09`, "ok");
  } catch (e) {
    toast(`\u53D6\u5F97\u5931\u6557: ${e.message}`, "error");
  } finally {
    downloading.delete(meta.cid);
    void renderChat();
  }
}
function renderDiscovery() {
  const conv = activeId ? conversations.get(activeId) : void 0;
  if (!conv) return;
  const ranked = conv.rankedCandidates();
  $("disc-count").textContent = String(ranked.length);
  $("disc-links").textContent = String(conv.connectedCount());
  $("disc-independent").textContent = conv.relayIndependent() ? "\u4F4E\uFF08\u30E1\u30C3\u30B7\u30E5\u81EA\u7ACB\uFF09" : "\u9AD8\uFF08\u63A2\u7D22\u4E2D\uFF09";
  $("disc-diversity").textContent = String(ranked.reduce((m, c) => Math.max(m, c.relay_count), 0));
  $("disc-list").innerHTML = ranked.slice(0, 10).map(
    (c, i) => `<li><span class="muted">${i + 1}.</span> <code>${escapeHtml(c.node_id.slice(0, 8))}</code>
           <span class="muted small">score ${c.score.toFixed(1)} \xB7 relay\xD7${c.relay_count}${c.via_peer_table ? " \xB7 peer-table" : ""}${c.latency_ms !== void 0 ? ` \xB7 ${Math.round(c.latency_ms)}ms` : ""}</span></li>`
  ).join("") || `<li class="muted">\u5019\u88DC\u306A\u3057</li>`;
}
function renderRelays() {
  const list = $("relay-list");
  list.innerHTML = relays.map(
    (url) => `<li><span style="flex:1;word-break:break-all">${escapeHtml(url)}</span><button class="btn small relay-rm" data-url="${escapeHtml(url)}">\u524A\u9664</button></li>`
  ).join("") || `<li class="muted">\u672A\u8A2D\u5B9A\uFF08\u63A2\u7D22\u3067\u304D\u307E\u305B\u3093\uFF09</li>`;
  for (const b of list.querySelectorAll(".relay-rm")) {
    b.onclick = () => void removeRelay(b.dataset["url"]);
  }
}
async function addRelay(url) {
  if (!/^wss?:\/\//.test(url)) throw new Error("ws:// \u307E\u305F\u306F wss:// \u3067\u59CB\u3081\u3066\u304F\u3060\u3055\u3044");
  if (relays.includes(url)) throw new Error("\u8FFD\u52A0\u6E08\u307F\u3067\u3059");
  relays = [...relays, url];
  await store.put("kv", "relays", relays);
  renderRelays();
  await rejoinAll();
  toast("Relay\u3092\u8FFD\u52A0\u3057\u307E\u3057\u305F\u3002\u518D\u63A5\u7D9A\u3057\u307E\u3059", "ok");
}
async function removeRelay(url) {
  relays = relays.filter((r) => r !== url);
  await store.put("kv", "relays", relays);
  renderRelays();
  await rejoinAll();
  toast("Relay\u3092\u524A\u9664\u3057\u307E\u3057\u305F", "info");
}
async function rejoinAll() {
  const specs = [...conversations.values()].map((c) => ({ ...c.spec, relays }));
  for (const c of conversations.values()) await c.stop();
  conversations.clear();
  for (const spec of specs) await addConversation(spec, false);
  if (activeId) setActive(activeId);
}
async function buildIdentity(stored) {
  const nodeKeys = await importKeyPair(stored);
  const ecdhKey = await importPrivateKeyForEcdh(stored.privateJwk);
  const myNodeId = await nodeIdFromPubkey(stored.publicKeyHex);
  return { nodeKeys, ecdhKey, myNodeId, pubkeyHex: stored.publicKeyHex };
}
async function firstRun(nick, relayUrl) {
  const keys = await exportKeyPair(await generateKeyPair());
  await store.put("kv", "identityKeys", keys);
  nickname = nick;
  await store.put("kv", "nickname", nickname);
  relays = relayUrl ? [relayUrl] : defaultRelays();
  await store.put("kv", "relays", relays);
  await boot();
}
async function boot() {
  const stored = await store.get("kv", "identityKeys");
  if (!stored) {
    $("welcome-nick").value ||= autoNickname();
    const forced2 = urlRelay();
    if (forced2) $("welcome-relay").value = forced2;
    $("welcome-relay-field").hidden = location.protocol.startsWith("http") && !forced2;
    $("welcome").hidden = false;
    $("layout").hidden = true;
    return;
  }
  identity = await buildIdentity(stored);
  reputation = Reputation.fromJSON(await store.all("peers"));
  reputation.onChange = (r) => void store.put("peers", r.node_id, r);
  nickname = await store.get("kv", "nickname") ?? autoNickname();
  relays = await store.get("kv", "relays") ?? defaultRelays();
  const forced = urlRelay();
  if (forced && !relays.includes(forced)) {
    relays = [forced, ...relays];
    await store.put("kv", "relays", relays);
  }
  $("welcome").hidden = true;
  $("layout").hidden = false;
  $("d-nick").value = nickname;
  $("my-id").value = identity.pubkeyHex;
  $("d-my-id").value = identity.pubkeyHex;
  renderRelays();
  const saved = await store.get("kv", "conversations") ?? [];
  for (const s of saved) {
    await addConversation({ network_id: s.network_id, kind: s.kind, room: s.room, title: s.title, relays, peerPubkey: s.peerPubkey }, false);
  }
  if (![...conversations.values()].some((c) => c.kind === "channel")) {
    await openChannel("general");
  } else {
    renderConvList();
  }
  if (relays.length === 0) {
    toast("Relay\u304C\u672A\u8A2D\u5B9A\u3067\u3059\u3002\u8A2D\u5B9A\u304B\u3089\u8FFD\u52A0\u3059\u308B\u3068\u76F8\u624B\u3092\u63A2\u7D22\u3067\u304D\u307E\u3059\u3002", "info");
  }
}
function openModal(id) {
  $("modal-scrim").hidden = false;
  $(id).hidden = false;
}
function closeModals() {
  $("modal-scrim").hidden = true;
  for (const m of ["modal-channel", "modal-dm"]) $(m).hidden = true;
}
function openDrawer(open) {
  $("drawer").hidden = !open;
  $("drawer-scrim").hidden = !open;
  if (open) {
    renderMembers();
    renderRelays();
    renderDiscovery();
  }
}
function busy(btn, fn) {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      btn.disabled = false;
    }
  };
}
async function setNickname(nick) {
  nickname = nick;
  await store.put("kv", "nickname", nickname);
  renderConvList();
  void renderChat();
  toast("\u8868\u793A\u540D\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F", "ok");
}
async function exportIdentity() {
  const keys = await store.get("kv", "identityKeys");
  const payload = {
    v: 1,
    nickname,
    relays,
    keys,
    conversations: await store.get("kv", "conversations") ?? []
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  a.download = "anp-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\uFF08\u79D8\u5BC6\u9375\u3092\u542B\u307F\u307E\u3059\uFF09", "info");
}
async function importIdentity(text) {
  const p = JSON.parse(text);
  if (p.v !== 1 || !p.keys?.privateJwk) throw new Error("\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u306E\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  await store.put("kv", "identityKeys", p.keys);
  await store.put("kv", "nickname", p.nickname ?? autoNickname());
  await store.put("kv", "relays", p.relays ?? defaultRelays());
  await store.put("kv", "conversations", p.conversations ?? []);
  location.reload();
}
async function resetAll() {
  for (const c of conversations.values()) await c.stop();
  await store.clearAll();
  location.reload();
}
async function shareActive() {
  const conv = activeId ? conversations.get(activeId) : void 0;
  if (!conv) return;
  if (conv.kind === "dm") {
    await copy(identity.pubkeyHex, "\u3042\u306A\u305F\u306EID\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\uFF08\u76F8\u624B\u306B\u6E21\u3057\u3066DM\u3067\u304D\u307E\u3059\uFF09");
    return;
  }
  const link = location.protocol.startsWith("http") ? `${location.origin}${location.pathname}#channel=${encodeURIComponent(conv.spec.room ?? "")}` : "";
  if (navigator.share && link) {
    try {
      await navigator.share({ title: "ANP Chat", text: `${conv.title} \u306B\u53C2\u52A0\u3057\u3088\u3046`, url: link });
      return;
    } catch {
    }
  }
  await copy(link || conv.title, "\u5171\u6709\u30EA\u30F3\u30AF\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F");
}
function wireUi() {
  busy($("btn-welcome-start"), async () => {
    const nick = $("welcome-nick").value.trim() || autoNickname();
    const relay = $("welcome-relay").value.trim();
    await firstRun(nick, relay);
  });
  $("btn-welcome-import-toggle").onclick = () => {
    const box = $("welcome-import-box");
    box.hidden = !box.hidden;
  };
  busy($("btn-welcome-import"), async () => {
    const text = $("welcome-import").value.trim();
    if (!text) throw new Error("JSON\u3092\u8CBC\u308A\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044");
    await importIdentity(text);
  });
  $("btn-new-channel").onclick = () => {
    $("channel-name").value = "";
    openModal("modal-channel");
  };
  $("btn-new-dm").onclick = () => {
    $("my-id").value = identity?.pubkeyHex ?? "";
    $("dm-peer-id").value = "";
    openModal("modal-dm");
  };
  $("btn-settings").onclick = () => openDrawer(true);
  $("modal-scrim").onclick = closeModals;
  for (const b of document.querySelectorAll(".modal-cancel")) b.onclick = closeModals;
  busy($("btn-channel-join"), async () => {
    await openChannel($("channel-name").value);
    closeModals();
  });
  $("btn-copy-id").onclick = () => void copy(identity?.pubkeyHex ?? "", "ID\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F");
  busy($("btn-dm-start"), async () => {
    await openDm($("dm-peer-id").value);
    closeModals();
  });
  $("btn-back").onclick = () => {
    document.body.classList.remove("chat-open");
  };
  $("conv-title").onclick = () => openDrawer(true);
  $("btn-share").onclick = () => void shareActive();
  const input = $("chat-input");
  $("composer").onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !activeId) return;
    input.value = "";
    void conversations.get(activeId)?.sendChat(text).catch((e) => toast(e.message, "error"));
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      $("composer").requestSubmit();
    }
  });
  const fileInput = $("file-input");
  $("btn-file").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file && activeId) void conversations.get(activeId)?.shareFile(file).catch((e) => toast(e.message, "error"));
  };
  $("btn-drawer-close").onclick = () => openDrawer(false);
  $("drawer-scrim").onclick = () => openDrawer(false);
  busy($("btn-save-nick"), async () => {
    const nick = $("d-nick").value.trim();
    if (!nick) throw new Error("\u8868\u793A\u540D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
    await setNickname(nick);
  });
  $("btn-copy-id2").onclick = () => void copy(identity?.pubkeyHex ?? "", "ID\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F");
  busy($("btn-relay-add"), async () => {
    const el = $("relay-add-url");
    if (!el.value.trim()) return;
    await addRelay(el.value.trim());
    el.value = "";
  });
  busy($("btn-export"), () => exportIdentity());
  $("btn-reset").onclick = () => {
    if (confirm("\u3059\u3079\u3066\u306E\u9375\u30FB\u4F1A\u8A71\u30FB\u5C65\u6B74\u3092\u524A\u9664\u3057\u307E\u3059\u3002\u3088\u308D\u3057\u3044\u3067\u3059\u304B?")) void resetAll();
  };
  window.addEventListener("hashchange", () => void handleChannelHash());
}
async function handleChannelHash() {
  const m = /[#&]channel=([^&]+)/.exec(location.hash);
  if (m && identity) {
    await openChannel(decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
}
function fatal(msg) {
  document.body.innerHTML = `<div class="overlay"><div class="welcome-card"><h2>\u8D77\u52D5\u3067\u304D\u307E\u305B\u3093</h2><p class="muted">${escapeHtml(msg)}</p></div></div>`;
}
function acquireSingleTabLock() {
  if (!("locks" in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request("anp-node", { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock) await new Promise(() => {
      });
    });
  });
}
void (async () => {
  if (!globalThis.crypto?.subtle) {
    fatal("\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u306F Web Crypto \u306B\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u305B\u3093\u3002");
    return;
  }
  if (!await acquireSingleTabLock()) {
    fatal("\u5225\u306E\u30BF\u30D6\u3067 ANP Chat \u304C\u8D77\u52D5\u4E2D\u3067\u3059\u3002\u30C7\u30FC\u30BF\u4FDD\u8B77\u306E\u305F\u3081\u3053\u306E\u30BF\u30D6\u306F\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
    return;
  }
  try {
    store = await AnpStore.open();
    wireUi();
    await boot();
    await handleChannelHash();
    if (store.ephemeral) toast("\u3053\u306E\u74B0\u5883\u3067\u306F\u5C65\u6B74\u304C\u4FDD\u5B58\u3055\u308C\u307E\u305B\u3093\uFF08\u30EA\u30ED\u30FC\u30C9\u3067\u6D88\u3048\u307E\u3059\uFF09\u3002", "info");
  } catch (err) {
    fatal(`\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${err.message}`);
  }
})();
//# sourceMappingURL=anp.js.map
