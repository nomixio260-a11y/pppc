/**
 * Discovery / transport events (design doc §6, §9), protocol v2.
 *
 * Every event is signed with the sender's node key; `id` is the sha256 of the
 * canonical event body. Relays and peers both run `verifyEvent` before
 * accepting anything.
 *
 * v2 additions:
 *  - JOIN events carry a proof-of-work nonce: the event id must have
 *    `POW_BITS` leading zero bits (§14.4). Mining happens before signing,
 *    so the signature covers the ground nonce.
 *  - SIGNAL events carry ECIES-encrypted payloads (offer/answer/trickle-ICE)
 *    plus a per-session sequence number for replay rejection.
 */

import {
  type EciesEnvelope,
  type KeyPairHandle,
  eciesDecrypt,
  eciesEncrypt,
  hasPow,
  nowSeconds,
  objectIdOf,
  signObject,
  randomHex,
  utf8Encode,
  verifyObject,
} from "./crypto.js";
import { nodeIdFromPubkey, openNetworkId, verifyInviteChain } from "./identity.js";
import type {
  AnpEvent,
  EventType,
  InviteCertificate,
  ManifestBody,
  NetworkId,
  NodeId,
  RevocationMap,
  SignalBody,
  SignalPayload,
} from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export const JOIN_TTL = 300;
export const HEARTBEAT_TTL = 90;
export const HEARTBEAT_INTERVAL = 30;
export const SIGNAL_TTL = 60;
export const MANIFEST_TTL = 600;

/** Leading zero bits required on a JOIN event id. ~4k hashes: instant for a
 * legitimate browser, meaningfully expensive for bulk identity minting. */
export const POW_BITS = 12;
const POW_MAX_ITERATIONS = 2_000_000;

interface CreateEventOptions {
  type: EventType;
  networkId: NetworkId;
  keys: KeyPairHandle;
  body: unknown;
  ttl: number;
}

export async function createEvent(opts: CreateEventOptions): Promise<AnpEvent> {
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
    signature: "",
  } as AnpEvent;
  event.signature = await signObject(opts.keys.privateKey, event as unknown as Record<string, unknown>);
  event.id = await objectIdOf(event as unknown as Record<string, unknown>);
  return event;
}

export interface VerifyOptions {
  now?: number;
  /** required leading zero bits on JOIN ids (default POW_BITS; 0 disables) */
  powBits?: number;
  /** revocation set consulted while validating JOIN invite chains */
  revoked?: RevocationMap;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Structural + cryptographic verification shared by relays and browser nodes:
 * shape, freshness, node_id/pubkey consistency, id integrity, signature,
 * JOIN proof-of-work, and — for JOIN — the invite chain rooted at the
 * genesis key (minus any revoked link).
 *
 * Never throws: malformed input from the network yields {ok:false}, so a
 * crafted event can not crash a relay or peer via an unhandled rejection.
 */
export async function verifyEvent(event: AnpEvent, opts: VerifyOptions = {}): Promise<VerifyResult> {
  try {
    return await verifyEventInner(event, opts);
  } catch (err) {
    return { ok: false, reason: `malformed event: ${(err as Error).message}` };
  }
}

async function verifyEventInner(event: AnpEvent, opts: VerifyOptions): Promise<VerifyResult> {
  const now = opts.now ?? nowSeconds();
  if (!event || typeof event !== "object") return { ok: false, reason: "not an object" };
  const { type, network_id, node_id, pubkey, signature } = event;
  if (!["JOIN", "HEARTBEAT", "LEAVE", "MANIFEST", "SIGNAL"].includes(type)) {
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
  if ((await nodeIdFromPubkey(pubkey)) !== node_id) {
    return { ok: false, reason: "node_id does not match pubkey" };
  }
  if ((await objectIdOf(event as unknown as Record<string, unknown>)) !== event.id) {
    return { ok: false, reason: "id mismatch" };
  }
  if (!(await verifyObject(pubkey, event as unknown as Record<string, unknown>))) {
    return { ok: false, reason: "bad signature" };
  }
  if (event.type === "JOIN") {
    const powBits = opts.powBits ?? POW_BITS;
    if (powBits > 0 && !hasPow(event.id, powBits)) {
      return { ok: false, reason: `insufficient proof-of-work (need ${powBits} bits)` };
    }
    const body = event.body;
    if (body?.open) {
      // open room: the network id must bind to the declared room name, so an
      // "open" join can never be used to slip into an invite-only network.
      if (typeof body.room !== "string" || !body.room) {
        return { ok: false, reason: "open join missing room" };
      }
      if ((await openNetworkId(body.room)) !== network_id) {
        return { ok: false, reason: "room does not match network id" };
      }
      // signature + PoW already verified; anyone may join an open room
    } else {
      const chain = (body?.invite_chain ?? []) as InviteCertificate[];
      const check = await verifyInviteChain(network_id, chain, pubkey, now, opts.revoked);
      if (!check.ok) return { ok: false, reason: `invite chain: ${check.reason}` };
    }
  }
  if (event.type === "SIGNAL") {
    const body = event.body as SignalBody;
    if (
      typeof body?.target !== "string" ||
      typeof body?.session !== "string" ||
      typeof body?.seq !== "number" ||
      typeof body?.enc?.epk !== "string" ||
      typeof body?.enc?.iv !== "string" ||
      typeof body?.enc?.ct !== "string"
    ) {
      return { ok: false, reason: "malformed signal body" };
    }
  }
  return { ok: true };
}

// Convenience constructors ---------------------------------------------------

/**
 * Build a JOIN event, grinding `pow_nonce` until the event id satisfies the
 * proof-of-work target, then signing once.
 */
export interface JoinOptions {
  nickname?: string;
  powBits?: number;
  /** open-room join: no invite chain; `room` binds to the network id */
  open?: boolean;
  room?: string;
}

export async function createJoin(
  networkId: NetworkId,
  keys: KeyPairHandle,
  inviteChain: InviteCertificate[],
  nicknameOrOpts?: string | JoinOptions,
  powBitsArg = POW_BITS,
): Promise<AnpEvent> {
  const opts: JoinOptions =
    typeof nicknameOrOpts === "string" || nicknameOrOpts === undefined
      ? { nickname: nicknameOrOpts, powBits: powBitsArg }
      : nicknameOrOpts;
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
      transport: { kind: "webrtc" as const },
      invite_chain: inviteChain,
      pow_nonce: "",
      nickname: opts.nickname,
      ...(opts.open ? { open: true, room: opts.room } : {}),
    },
    signature: "",
  } as AnpEvent;

  for (let i = 0; i < POW_MAX_ITERATIONS; i++) {
    (event.body as { pow_nonce: string }).pow_nonce = randomHex(8);
    const id = await objectIdOf(event as unknown as Record<string, unknown>);
    if (powBits <= 0 || hasPow(id, powBits)) {
      event.signature = await signObject(keys.privateKey, event as unknown as Record<string, unknown>);
      event.id = id;
      return event;
    }
  }
  throw new Error("proof-of-work search exhausted");
}

export async function createHeartbeat(networkId: NetworkId, keys: KeyPairHandle): Promise<AnpEvent> {
  return createEvent({ type: "HEARTBEAT", networkId, keys, ttl: HEARTBEAT_TTL, body: {} });
}

export async function createLeave(networkId: NetworkId, keys: KeyPairHandle): Promise<AnpEvent> {
  return createEvent({ type: "LEAVE", networkId, keys, ttl: HEARTBEAT_TTL, body: {} });
}

export async function createManifest(
  networkId: NetworkId,
  keys: KeyPairHandle,
  body: ManifestBody,
): Promise<AnpEvent> {
  return createEvent({ type: "MANIFEST", networkId, keys, ttl: MANIFEST_TTL, body });
}

/** Encrypt a signal payload to the target's public key and wrap it in a signed SIGNAL event. */
export async function createSignal(
  networkId: NetworkId,
  keys: KeyPairHandle,
  target: NodeId,
  targetPubkey: string,
  session: string,
  seq: number,
  payload: SignalPayload,
): Promise<AnpEvent> {
  const enc = await eciesEncrypt(targetPubkey, utf8Encode(JSON.stringify(payload)));
  const body: SignalBody = { target, session, seq, enc };
  return createEvent({ type: "SIGNAL", networkId, keys, ttl: SIGNAL_TTL, body });
}

/** Decrypt a SIGNAL payload addressed to us. Returns null when undecryptable. */
export async function decryptSignal(
  myEcdhPrivateKey: CryptoKey,
  myPubkeyHex: string,
  enc: EciesEnvelope,
): Promise<SignalPayload | null> {
  try {
    const plaintext = await eciesDecrypt(myEcdhPrivateKey, myPubkeyHex, enc);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SignalPayload;
    if (payload.kind !== "offer" && payload.kind !== "answer" && payload.kind !== "ice") return null;
    return payload;
  } catch {
    return null;
  }
}
