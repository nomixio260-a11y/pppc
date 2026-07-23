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
  Right,
} from "./types.js";

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
 */
export async function verifyInviteChain(
  networkId: NetworkId,
  chain: InviteCertificate[],
  subjectPubkey: PubKeyHex,
  now = nowSeconds(),
): Promise<{ ok: boolean; rights: Right[]; reason?: string }> {
  if ((await networkIdFromGenesisPubkey(subjectPubkey)) === networkId) {
    return { ok: true, rights: ["join", "invite", "chat", "store", "admin"] };
  }
  if (chain.length === 0) return { ok: false, rights: [], reason: "empty invite chain" };

  const first = chain[0]!;
  if ((await networkIdFromGenesisPubkey(first.issuer_pubkey)) !== networkId) {
    return { ok: false, rights: [], reason: "chain not rooted at genesis key" };
  }

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    if (cert.network_id !== networkId) return { ok: false, rights: [], reason: `link ${i}: wrong network` };
    if (!(await verifyCertificate(cert, now))) {
      return { ok: false, rights: [], reason: `link ${i}: invalid, revoked or expired` };
    }
    if (i > 0) {
      const prev = chain[i - 1]!;
      if (cert.issuer_pubkey !== prev.subject_pubkey) {
        return { ok: false, rights: [], reason: `link ${i}: broken chain` };
      }
      if (!prev.rights.includes("invite")) {
        return { ok: false, rights: [], reason: `link ${i - 1}: issuer lacks invite right` };
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
