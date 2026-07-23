/**
 * Shared protocol types for ANP.
 *
 * Layer map (design doc §3):
 *  - Identity Layer:  NetworkId, NodeId, InviteCertificate, signatures
 *  - Discovery Layer: AnpEvent (JOIN / HEARTBEAT / LEAVE / MANIFEST) over relays
 *  - Transport Layer: SIGNAL events carry WebRTC offer/answer, then DataChannel
 *  - Data Layer:      NameRecord, CRDT documents, content-addressed blobs
 */

/** hex sha256 of the genesis public key — the fixed network name (anp://<network-id>) */
export type NetworkId = string;
/** hex sha256 of a node public key */
export type NodeId = string;
/** hex raw uncompressed P-256 public key */
export type PubKeyHex = string;

export type Right = "join" | "invite" | "chat" | "store" | "admin";

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
  transport: { kind: "webrtc" };
  /** invite chain, rooted at the genesis key; empty only for the genesis node itself */
  invite_chain: InviteCertificate[];
  /** human-readable display name (optional, unauthenticated hint) */
  nickname?: string;
}

export interface ManifestBody {
  relays: string[];
  records: NameRecord[];
}

export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string };

export interface SignalBody {
  /** node the signal is addressed to */
  target: NodeId;
  /** distinguishes parallel connection attempts */
  session: string;
  payload: SignalPayload;
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
// Peer table entry (Data Layer, synced over DataChannel)
// ---------------------------------------------------------------------------

export interface PeerInfo {
  node_id: NodeId;
  pubkey: PubKeyHex;
  nickname?: string;
  last_seen: number;
  rights: Right[];
}
