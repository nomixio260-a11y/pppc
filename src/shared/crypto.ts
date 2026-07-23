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
