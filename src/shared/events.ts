/**
 * Discovery / transport events (design doc §6, §9).
 *
 * Every event is signed with the sender's node key; `id` is the sha256 of the
 * canonical event body. Relays and peers both run `verifyEvent` before
 * accepting anything.
 */

import { type KeyPairHandle, nowSeconds, objectIdOf, signObject, verifyObject } from "./crypto.js";
import { nodeIdFromPubkey, verifyInviteChain } from "./identity.js";
import type {
  AnpEvent,
  EventType,
  InviteCertificate,
  ManifestBody,
  NetworkId,
  SignalBody,
} from "./types.js";

export const JOIN_TTL = 300;
export const HEARTBEAT_TTL = 90;
export const HEARTBEAT_INTERVAL = 30;
export const SIGNAL_TTL = 60;
export const MANIFEST_TTL = 600;

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

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Structural + cryptographic verification shared by relays and browser nodes:
 * shape, freshness, node_id/pubkey consistency, id integrity, signature, and
 * — for JOIN — the invite chain rooted at the genesis key.
 */
export async function verifyEvent(event: AnpEvent, now = nowSeconds()): Promise<VerifyResult> {
  if (!event || typeof event !== "object") return { ok: false, reason: "not an object" };
  const { type, network_id, node_id, pubkey, signature } = event;
  if (!["JOIN", "HEARTBEAT", "LEAVE", "MANIFEST", "SIGNAL"].includes(type)) {
    return { ok: false, reason: "unknown event type" };
  }
  if (typeof network_id !== "string" || !/^[0-9a-f]{64}$/.test(network_id)) {
    return { ok: false, reason: "bad network_id" };
  }
  if (typeof pubkey !== "string" || typeof signature !== "string") {
    return { ok: false, reason: "missing pubkey/signature" };
  }
  if (typeof event.expires_at !== "number" || event.expires_at <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof event.created_at !== "number" || event.created_at > now + 300) {
    return { ok: false, reason: "created_at in the future" };
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
    const chain = (event.body?.invite_chain ?? []) as InviteCertificate[];
    const check = await verifyInviteChain(network_id, chain, pubkey, now);
    if (!check.ok) return { ok: false, reason: `invite chain: ${check.reason}` };
  }
  if (event.type === "SIGNAL") {
    const body = event.body as SignalBody;
    if (typeof body?.target !== "string" || !body?.payload?.kind) {
      return { ok: false, reason: "malformed signal body" };
    }
  }
  return { ok: true };
}

// Convenience constructors ---------------------------------------------------

export async function createJoin(
  networkId: NetworkId,
  keys: KeyPairHandle,
  inviteChain: InviteCertificate[],
  nickname?: string,
): Promise<AnpEvent> {
  return createEvent({
    type: "JOIN",
    networkId,
    keys,
    ttl: JOIN_TTL,
    body: { transport: { kind: "webrtc" }, invite_chain: inviteChain, nickname },
  });
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

export async function createSignal(
  networkId: NetworkId,
  keys: KeyPairHandle,
  body: SignalBody,
): Promise<AnpEvent> {
  return createEvent({ type: "SIGNAL", networkId, keys, ttl: SIGNAL_TTL, body });
}
