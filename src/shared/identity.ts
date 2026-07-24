/**
 * Identity Layer (design doc §4, §12).
 *
 *   Genesis Secret Key -> Genesis Public Key -> SHA-256 -> Network ID
 *   Node Secret Key    -> Node Public Key    -> SHA-256 -> Node ID
 *
 * Membership is proven by an invite chain: a list of InviteCertificates whose
 * first link is signed by the genesis key and whose last link names the
 * joining node's public key. Any link that carries the "invite" right may
 * issue the next link.
 */

import {
  type KeyPairHandle,
  base64UrlDecode,
  base64UrlEncode,
  nowSeconds,
  randomHex,
  sha256Hex,
  hexToBytes,
  signObject,
  utf8Encode,
  verifyObject,
} from "./crypto.js";
import type {
  InviteBundle,
  InviteCertificate,
  NetworkId,
  NodeId,
  PubKeyHex,
  RevocationMap,
  Right,
} from "./types.js";

/** Hard cap on invite-chain length (verification CPU bound). */
export const MAX_CHAIN_LENGTH = 16;

/**
 * Open rooms (default mode): a public network anyone can join by knowing the
 * room name — no genesis key, no invite chain. The network id is bound to the
 * room name so an "open" join can never target an invite-only network.
 *
 *   room name -> SHA-256("anp-open-v1:" + room) -> Network ID
 *
 * Sybil resistance comes from JOIN proof-of-work and the local trust score;
 * message authenticity from per-entry signatures.
 */
export const OPEN_PREFIX = "anp-open-v1:";

export async function openNetworkId(room: string): Promise<NetworkId> {
  return sha256Hex(utf8Encode(OPEN_PREFIX + room));
}

/** Normalize a room name (trim, lowercase, collapse spaces) so casing/spacing
 * variants resolve to the same room. */
export function normalizeRoom(room: string): string {
  return room.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}

export async function networkIdFromGenesisPubkey(genesisPubkeyHex: PubKeyHex): Promise<NetworkId> {
  return sha256Hex(hexToBytes(genesisPubkeyHex));
}

export async function nodeIdFromPubkey(pubkeyHex: PubKeyHex): Promise<NodeId> {
  return sha256Hex(hexToBytes(pubkeyHex));
}

export function anpUrl(networkId: NetworkId): string {
  return `anp://${networkId}`;
}

export function parseAnpUrl(url: string): NetworkId | null {
  const match = /^anp:\/\/([0-9a-f]{64})$/.exec(url.trim());
  return match ? (match[1] as NetworkId) : null;
}

// ---------------------------------------------------------------------------
// Invitation certificates
// ---------------------------------------------------------------------------

export interface IssueCertOptions {
  networkId: NetworkId;
  issuer: KeyPairHandle;
  subjectPubkey: PubKeyHex;
  rights: Right[];
  /** lifetime in seconds (default: 30 days) */
  ttl?: number;
}

export async function issueCertificate(opts: IssueCertOptions): Promise<InviteCertificate> {
  const issuedAt = nowSeconds();
  const cert: InviteCertificate = {
    type: "INVITE",
    network_id: opts.networkId,
    invite_id: `inv-${randomHex(8)}`,
    issuer_pubkey: opts.issuer.publicKeyHex,
    subject_pubkey: opts.subjectPubkey,
    rights: opts.rights,
    issued_at: issuedAt,
    expires_at: issuedAt + (opts.ttl ?? 30 * 24 * 3600),
    revoked: false,
    signature: "",
  };
  cert.signature = await signObject(opts.issuer.privateKey, cert as unknown as Record<string, unknown>, [
    "signature",
  ]);
  return cert;
}

export async function verifyCertificate(cert: InviteCertificate, now = nowSeconds()): Promise<boolean> {
  if (cert.type !== "INVITE") return false;
  if (cert.revoked) return false;
  if (cert.expires_at <= now) return false;
  return verifyObject(cert.issuer_pubkey, cert as unknown as Record<string, unknown>, ["signature"]);
}

/**
 * Verify a full invite chain for `subjectPubkey` on `networkId`.
 *
 * Rules:
 *  - The genesis node itself (pubkey hashes to the network id) needs no chain.
 *  - Otherwise the chain must be non-empty, its first link signed by the
 *    genesis key, each intermediate link must carry the "invite" right, links
 *    must connect (issuer of link N+1 == subject of link N), and the final
 *    link must name `subjectPubkey` with the "join" right.
 *  - If `revoked` is given, any link whose invite_id was revoked by its own
 *    issuer or by the genesis key invalidates the whole chain (protocol v2).
 *  - `ignoreExpiry` relaxes only the time checks (structure, signatures and
 *    revocation still apply). Used to authenticate *historical* CRDT entries
 *    from members whose certificates have since expired — without it, chat
 *    history written by a lapsed member could never be verified by a new
 *    node. It must never gate live connections or NS writes.
 */
export async function verifyInviteChain(
  networkId: NetworkId,
  chain: InviteCertificate[],
  subjectPubkey: PubKeyHex,
  now = nowSeconds(),
  revoked?: RevocationMap,
  ignoreExpiry = false,
): Promise<{ ok: boolean; rights: Right[]; reason?: string }> {
  if ((await networkIdFromGenesisPubkey(subjectPubkey)) === networkId) {
    return { ok: true, rights: ["join", "invite", "chat", "store", "admin"] };
  }
  if (chain.length === 0) return { ok: false, rights: [], reason: "empty invite chain" };
  if (chain.length > MAX_CHAIN_LENGTH) {
    return { ok: false, rights: [], reason: "invite chain too long" };
  }

  const first = chain[0]!;
  if ((await networkIdFromGenesisPubkey(first.issuer_pubkey)) !== networkId) {
    return { ok: false, rights: [], reason: "chain not rooted at genesis key" };
  }
  const genesisPubkey = first.issuer_pubkey;

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    if (cert.network_id !== networkId) return { ok: false, rights: [], reason: `link ${i}: wrong network` };
    const certNow = ignoreExpiry ? cert.issued_at + 1 : now;
    if (!(await verifyCertificate(cert, certNow))) {
      return { ok: false, rights: [], reason: `link ${i}: invalid, revoked or expired` };
    }
    if (isCertRevoked(cert, genesisPubkey, revoked)) {
      return { ok: false, rights: [], reason: `link ${i}: certificate revoked (${cert.invite_id})` };
    }
    if (i > 0) {
      const prev = chain[i - 1]!;
      if (cert.issuer_pubkey !== prev.subject_pubkey) {
        return { ok: false, rights: [], reason: `link ${i}: broken chain` };
      }
      if (!prev.rights.includes("invite")) {
        return { ok: false, rights: [], reason: `link ${i - 1}: issuer lacks invite right` };
      }
      // no privilege escalation: an issuer can only delegate rights it holds
      if (!cert.rights.every((right) => prev.rights.includes(right))) {
        return { ok: false, rights: [], reason: `link ${i}: rights exceed issuer's rights` };
      }
    }
  }

  const last = chain[chain.length - 1]!;
  if (last.subject_pubkey !== subjectPubkey) {
    return { ok: false, rights: [], reason: "chain does not name this node" };
  }
  if (!last.rights.includes("join")) {
    return { ok: false, rights: [], reason: "final link lacks join right" };
  }
  return { ok: true, rights: last.rights };
}

/**
 * A revocation only counts when published by a key with authority over the
 * certificate: its issuer, or the genesis key (network root of trust).
 */
export function isCertRevoked(
  cert: InviteCertificate,
  genesisPubkey: PubKeyHex,
  revoked?: RevocationMap,
): boolean {
  const revokers = revoked?.get(cert.invite_id);
  if (!revokers) return false;
  return revokers.has(cert.issuer_pubkey) || revokers.has(genesisPubkey);
}

// ---------------------------------------------------------------------------
// Invite bundles (out-of-band handoff)
// ---------------------------------------------------------------------------

export function encodeInviteBundle(bundle: InviteBundle): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(bundle)));
}

export function decodeInviteBundle(text: string): InviteBundle {
  const json = new TextDecoder().decode(base64UrlDecode(text.trim()));
  const bundle = JSON.parse(json) as InviteBundle;
  if (bundle.v !== 1 || !bundle.network_id || !Array.isArray(bundle.chain)) {
    throw new Error("malformed invite bundle");
  }
  return bundle;
}
