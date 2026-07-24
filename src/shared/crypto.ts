/**
 * Crypto primitives for ANP, built on the Web Crypto API.
 * Works identically in browsers and Node.js (>= 20), since both expose
 * `globalThis.crypto.subtle`.
 *
 * Algorithm choices:
 *  - Signatures: ECDSA P-256 with SHA-256
 *  - Hashing:    SHA-256
 *  - Public keys serialized as raw uncompressed points (65 bytes), hex-encoded
 *  - Private keys serialized as JWK for IndexedDB persistence
 */

const subtle = globalThis.crypto.subtle;

export const ECDSA_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
export const SIGN_PARAMS: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex string");
    out[i] = byte;
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at
 * every depth, arrays kept in order. Signatures and content IDs are always
 * computed over this canonical form so that every node derives identical
 * bytes from identical logical content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** Content ID for content-addressed blobs (Data Layer). */
export async function cidOf(data: Uint8Array | string): Promise<string> {
  return `cid:sha256:${await sha256Hex(data)}`;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

export interface KeyPairHandle {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** hex of raw uncompressed public point (65 bytes) */
  publicKeyHex: string;
}

export async function generateKeyPair(): Promise<KeyPairHandle> {
  const pair = (await subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicKeyHex: bytesToHex(raw) };
}

export async function importPublicKeyHex(publicKeyHex: string): Promise<CryptoKey> {
  return subtle.importKey("raw", hexToBytes(publicKeyHex) as BufferSource, ECDSA_PARAMS, true, ["verify"]);
}

export interface StoredKeyPair {
  publicKeyHex: string;
  privateJwk: JsonWebKey;
}

export async function exportKeyPair(pair: KeyPairHandle): Promise<StoredKeyPair> {
  return {
    publicKeyHex: pair.publicKeyHex,
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function importKeyPair(stored: StoredKeyPair): Promise<KeyPairHandle> {
  const privateKey = await subtle.importKey("jwk", stored.privateJwk, ECDSA_PARAMS, true, ["sign"]);
  const publicKey = await importPublicKeyHex(stored.publicKeyHex);
  return { publicKey, privateKey, publicKeyHex: stored.publicKeyHex };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await subtle.sign(SIGN_PARAMS, privateKey, data as BufferSource);
  return bytesToHex(new Uint8Array(sig));
}

export async function verifyBytes(
  publicKeyHex: string,
  signatureHex: string,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const key = await importPublicKeyHex(publicKeyHex);
    return await subtle.verify(SIGN_PARAMS, key, hexToBytes(signatureHex) as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

/** Sign the canonical JSON form of `value` (with `omit` fields removed). */
export async function signObject(
  privateKey: CryptoKey,
  value: Record<string, unknown>,
  omit: string[] = ["signature", "id"],
): Promise<string> {
  const clone: Record<string, unknown> = { ...value };
  for (const field of omit) delete clone[field];
  return signBytes(privateKey, utf8Encode(canonicalJson(clone)));
}

export async function verifyObject(
  publicKeyHex: string,
  value: Record<string, unknown>,
  omit: string[] = ["signature", "id"],
): Promise<boolean> {
  const signature = value["signature"];
  if (typeof signature !== "string") return false;
  const clone: Record<string, unknown> = { ...value };
  for (const field of omit) delete clone[field];
  return verifyBytes(publicKeyHex, signature, utf8Encode(canonicalJson(clone)));
}

export async function objectIdOf(
  value: Record<string, unknown>,
  omit: string[] = ["signature", "id"],
): Promise<string> {
  const clone: Record<string, unknown> = { ...value };
  for (const field of omit) delete clone[field];
  return sha256Hex(canonicalJson(clone));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

// ---------------------------------------------------------------------------
// ECIES (ECDH-ES + HKDF + AES-256-GCM)
//
// Used to encrypt SIGNAL payloads end-to-end between nodes, so relays never
// see SDP contents (which include local/public IP addresses). The same P-256
// key pair used for ECDSA signatures is re-imported for ECDH key agreement.
// ---------------------------------------------------------------------------

export interface EciesEnvelope {
  /** ephemeral sender public key, raw hex */
  epk: string;
  /** AES-GCM IV, hex */
  iv: string;
  /** ciphertext, base64url */
  ct: string;
}

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const HKDF_INFO = utf8Encode("anp-signal-v2");

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  saltHex: string,
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hexToBytes(saltHex) as BufferSource, info: HKDF_INFO as BufferSource },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function importPublicKeyForEcdh(publicKeyHex: string): Promise<CryptoKey> {
  return subtle.importKey("raw", hexToBytes(publicKeyHex) as BufferSource, ECDH_PARAMS, false, []);
}

/** Re-import an ECDSA private JWK for ECDH key agreement. */
export async function importPrivateKeyForEcdh(privateJwk: JsonWebKey): Promise<CryptoKey> {
  const jwk: JsonWebKey = { ...privateJwk, key_ops: ["deriveBits"] };
  delete (jwk as Record<string, unknown>)["alg"];
  return subtle.importKey("jwk", jwk, ECDH_PARAMS, false, ["deriveBits"]);
}

/**
 * Derive the symmetric key for a DM between us and `peerPubkeyHex`. ECDH is
 * symmetric, so both parties compute the same key from (their private, other's
 * public). Bound to the sorted pubkey pair via the HKDF salt so the key is
 * unique per conversation.
 */
export async function deriveDmKey(myEcdhPrivateKey: CryptoKey, peerPubkeyHex: string, myPubkeyHex: string): Promise<CryptoKey> {
  const peer = await importPublicKeyForEcdh(peerPubkeyHex);
  const salt = [myPubkeyHex, peerPubkeyHex].sort().join(":");
  return deriveAesKey(myEcdhPrivateKey, peer, await sha256Hex(salt));
}

export async function dmEncrypt(key: CryptoKey, plaintext: string): Promise<{ iv: string; ct: string }> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, utf8Encode(plaintext) as BufferSource);
  return { iv: bytesToHex(iv), ct: base64UrlEncode(new Uint8Array(ct)) };
}

export async function dmDecrypt(key: CryptoKey, env: { iv: string; ct: string }): Promise<string | null> {
  try {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(env.iv) as BufferSource },
      key,
      base64UrlDecode(env.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function eciesEncrypt(recipientPubkeyHex: string, plaintext: Uint8Array): Promise<EciesEnvelope> {
  const eph = (await subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"])) as CryptoKeyPair;
  const epkHex = bytesToHex(new Uint8Array(await subtle.exportKey("raw", eph.publicKey)));
  const recipient = await importPublicKeyForEcdh(recipientPubkeyHex);
  const aesKey = await deriveAesKey(eph.privateKey, recipient, epkHex + recipientPubkeyHex);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, plaintext as BufferSource);
  return { epk: epkHex, iv: bytesToHex(iv), ct: base64UrlEncode(new Uint8Array(ct)) };
}

export async function eciesDecrypt(
  recipientPrivateEcdh: CryptoKey,
  recipientPubkeyHex: string,
  envelope: EciesEnvelope,
): Promise<Uint8Array> {
  const epk = await importPublicKeyForEcdh(envelope.epk);
  const aesKey = await deriveAesKey(recipientPrivateEcdh, epk, envelope.epk + recipientPubkeyHex);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(envelope.iv) as BufferSource },
    aesKey,
    base64UrlDecode(envelope.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// Lightweight proof-of-work (design doc §14.4, Sybil resistance)
//
// A JOIN event must have an id (sha256 of its canonical form) with at least
// `bits` leading zero bits; the sender grinds `body.pow_nonce` until it does.
// At the default 12 bits this is ~4096 hashes (milliseconds), yet it makes
// bulk identity minting measurably expensive.
// ---------------------------------------------------------------------------

export function leadingZeroBits(hex: string): number {
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

export function hasPow(idHex: string, bits: number): boolean {
  return leadingZeroBits(idHex) >= bits;
}
