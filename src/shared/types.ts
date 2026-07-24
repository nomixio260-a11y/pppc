/**
 * Shared protocol types for ANP (protocol v2).
 *
 * Layer map (design doc §3):
 *  - Identity Layer:  NetworkId, NodeId, InviteCertificate, signatures
 *  - Discovery Layer: AnpEvent (JOIN / HEARTBEAT / LEAVE / MANIFEST) over relays
 *  - Transport Layer: SIGNAL events carry E2E-encrypted WebRTC SDP/ICE,
 *                     then everything moves to DataChannels
 *  - Data Layer:      NameRecord, CRDT documents, content-addressed blobs
 *
 * Protocol v2 evolutions over the design doc:
 *  - SIGNAL payloads are ECIES-encrypted to the target node, so relays never
 *    see SDP (which contains IP addresses). Trickle ICE via `ice` payloads.
 *  - JOIN events carry a light proof-of-work nonce (§14.4 Sybil resistance).
 *  - Chat/profile CRDT entries are signed by their origin node and bound to
 *    a membership registry, so members cannot forge each other's writes.
 *  - Invite certificates can be revoked via replicated `revoked/<invite_id>`
 *    name-service records signed by the certificate issuer or the genesis key.
 */

import type { EciesEnvelope } from "./crypto.js";

/** hex sha256 of the genesis public key — the fixed network name (anp://<network-id>) */
export type NetworkId = string;
/** hex sha256 of a node public key */
export type NodeId = string;
/** hex raw uncompressed P-256 public key */
export type PubKeyHex = string;

export type Right = "join" | "invite" | "chat" | "store" | "admin";

export const PROTOCOL_VERSION = 2;

/**
 * Invitation Certificate (design doc §4.3 / §12).
 * A chain of these, rooted at the genesis key, authorizes a node to join.
 */
export interface InviteCertificate {
  type: "INVITE";
  network_id: NetworkId;
  invite_id: string;
  issuer_pubkey: PubKeyHex;
  subject_pubkey: PubKeyHex;
  rights: Right[];
  issued_at: number;
  expires_at: number;
  revoked: boolean;
  signature: string;
}

/**
 * Revocation of an invite certificate: replicated as a name-service record
 * `revoked/<invite_id>` whose value is this shape. Honored when the NS
 * record author is the certificate's issuer or the genesis key.
 */
export interface RevocationValue {
  kind: "revocation";
  invite_id: string;
  reason?: string;
}

/** invite_id -> set of pubkeys that published a revocation for it */
export type RevocationMap = Map<string, Set<PubKeyHex>>;

// ---------------------------------------------------------------------------
// Discovery / transport events (design doc §6, §7, §9)
// ---------------------------------------------------------------------------

export type EventType = "JOIN" | "HEARTBEAT" | "LEAVE" | "MANIFEST" | "SIGNAL";

export interface EventBase {
  /** sha256 of the canonical event without `id`/`signature` */
  id: string;
  type: EventType;
  network_id: NetworkId;
  node_id: NodeId;
  pubkey: PubKeyHex;
  created_at: number;
  expires_at: number;
  signature: string;
}

export interface JoinBody {
  proto: number;
  transport: { kind: "webrtc" };
  /** invite chain, rooted at the genesis key; empty only for the genesis node itself */
  invite_chain: InviteCertificate[];
  /** ground nonce making the event id satisfy the network's PoW target */
  pow_nonce: string;
  /** human-readable display name (authenticated by the event signature) */
  nickname?: string;
}

export interface ManifestBody {
  relays: string[];
  records: NameRecord[];
}

/** Decrypted contents of a SIGNAL event (ECIES plaintext). */
export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit | null };

export interface SignalBody {
  /** node the signal is addressed to */
  target: NodeId;
  /** distinguishes parallel connection attempts */
  session: string;
  /** monotonically increasing per (sender, session); receivers drop replays */
  seq: number;
  /** ECIES envelope containing the JSON-encoded SignalPayload */
  enc: EciesEnvelope;
}

export interface JoinEvent extends EventBase {
  type: "JOIN";
  body: JoinBody;
}
export interface HeartbeatEvent extends EventBase {
  type: "HEARTBEAT";
  body: Record<string, never>;
}
export interface LeaveEvent extends EventBase {
  type: "LEAVE";
  body: Record<string, never>;
}
export interface ManifestEvent extends EventBase {
  type: "MANIFEST";
  body: ManifestBody;
}
export interface SignalEvent extends EventBase {
  type: "SIGNAL";
  body: SignalBody;
}

export type AnpEvent = JoinEvent | HeartbeatEvent | LeaveEvent | ManifestEvent | SignalEvent;

// ---------------------------------------------------------------------------
// Relay wire protocol (design doc §7.2) — Nostr-like WebSocket frames
// ---------------------------------------------------------------------------

export interface EventFilter {
  network_id: NetworkId;
  types?: EventType[];
  node_id?: NodeId;
  /** only SIGNAL events addressed to this node (plus non-SIGNAL matches) */
  target?: NodeId;
  since?: number;
}

/** client -> relay */
export type ClientFrame =
  | { frame: "EVENT"; event: AnpEvent }
  | { frame: "REQ"; sub_id: string; filter: EventFilter }
  | { frame: "CLOSE"; sub_id: string };

/** relay -> client */
export type RelayFrame =
  | { frame: "EVENT"; sub_id: string; event: AnpEvent }
  | { frame: "EOSE"; sub_id: string }
  | { frame: "OK"; event_id: string; accepted: boolean; message?: string }
  | { frame: "NOTICE"; message: string };

// ---------------------------------------------------------------------------
// Name Service (design doc §10)
// ---------------------------------------------------------------------------

export interface NameRecord {
  network_id: NetworkId;
  name: string;
  value: unknown;
  version: number;
  ttl: number;
  updated_at: number;
  author_pubkey: PubKeyHex;
  signature: string;
}

// ---------------------------------------------------------------------------
// Invite bundle — what an inviter hands to an invitee out-of-band
// ---------------------------------------------------------------------------

export interface InviteBundle {
  v: 1;
  network_id: NetworkId;
  genesis_pubkey: PubKeyHex;
  relays: string[];
  chain: InviteCertificate[];
}

// ---------------------------------------------------------------------------
// Membership registry (Data Layer)
//
// Built from cryptographically verified JOIN events and MEMBER_PROOF
// DataChannel messages. CRDT writes are only accepted from registered
// members, which stops a member from injecting entries under fabricated
// origins (§14.4).
// ---------------------------------------------------------------------------

export interface MemberRecord {
  node_id: NodeId;
  pubkey: PubKeyHex;
  nickname?: string;
  rights: Right[];
  invite_chain: InviteCertificate[];
  verified_at: number;
  /**
   * True when the chain only passed the relaxed (expiry-ignoring) check:
   * good enough to authenticate this member's historical CRDT entries, but
   * not for live connections or name-service writes.
   */
  historical?: boolean;
}

/** Live peer-table entry (discovery view; superset source is `MemberRecord`). */
export interface PeerInfo {
  node_id: NodeId;
  pubkey: PubKeyHex;
  nickname?: string;
  last_seen: number;
  rights: Right[];
}

// ---------------------------------------------------------------------------
// File sharing (service/files): content-addressed blob metadata
// ---------------------------------------------------------------------------

export interface FileMeta {
  cid: string;
  name: string;
  size: number;
  mime: string;
}
