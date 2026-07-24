/**
 * CRDTs for ANP's Data Layer (design doc §11.3), protocol v2.
 *
 * Two small, dependency-free CRDTs cover the MVP services:
 *
 *  - GSetLog: a grow-only set of entries with a deterministic total order
 *    (lamport, then entry id). Used for `service/chat`. Merging is set
 *    union, so replicas converge regardless of delivery order or
 *    duplication. Anti-entropy uses a per-origin VERSION VECTOR
 *    (origin -> max seq), which — unlike a single lamport watermark —
 *    cannot miss entries from origins the requester has never seen.
 *
 *  - LwwMap: last-writer-wins register map keyed by string. Used for
 *    `service/profile`. Ties break on replica id so the merge is a total
 *    order.
 *
 * Authenticity (protocol v2): entries and cells carry an origin signature.
 * `signLogEntry` / `verifyLogEntry` bind an entry to its origin node key
 * (origin must equal sha256(pubkey)); the same for profile cells, whose keys
 * must live under the writer's own namespace (`<field>/<node_id>`). Peers
 * verify before merging, so a member cannot forge another member's messages
 * or profile fields.
 */

import { canonicalJson, nowSeconds, sha256Hex, signBytes, utf8Encode, verifyBytes, hexToBytes } from "./crypto.js";

export type VersionVector = Record<string, number>;

/**
 * Replica identifiers are `<node_id>` or `<node_id>.<epoch>` where epoch is a
 * random per-log-instance suffix. Without the epoch, restoring the same
 * identity in a second browser (or after an IndexedDB wipe) would mint new
 * entries under already-used `${origin}:${seq}` ids — silently diverging the
 * whole network. Distinct epochs keep every entry id globally unique while
 * the signature check still binds the replica to its node key.
 */
export function replicaNodeId(replica: string): string {
  const dot = replica.indexOf(".");
  return dot === -1 ? replica : replica.slice(0, dot);
}

export interface LogEntry {
  /** globally unique: `${origin}:${seq}` */
  id: string;
  origin: string;
  seq: number;
  lamport: number;
  /** unix seconds, informational only (ordering uses lamport+id) */
  ts: number;
  kind: string;
  data: unknown;
  /** origin node's public key (hex); sha256(pubkey) must equal replicaNodeId(origin) */
  pubkey?: string;
  /** ECDSA signature over the canonical entry without `sig` */
  sig?: string;
}

export async function signLogEntry(
  privateKey: CryptoKey,
  publicKeyHex: string,
  entry: LogEntry,
): Promise<LogEntry> {
  entry.pubkey = publicKeyHex;
  const clone: Record<string, unknown> = { ...entry };
  delete clone["sig"];
  entry.sig = await signBytes(privateKey, utf8Encode(canonicalJson(clone)));
  return entry;
}

export async function verifyLogEntry(entry: LogEntry): Promise<boolean> {
  try {
    if (!entry || typeof entry.id !== "string" || typeof entry.origin !== "string") return false;
    if (typeof entry.seq !== "number" || typeof entry.lamport !== "number") return false;
    if (entry.id !== `${entry.origin}:${entry.seq}`) return false;
    if (typeof entry.pubkey !== "string" || typeof entry.sig !== "string") return false;
    if ((await sha256Hex(hexToBytes(entry.pubkey))) !== replicaNodeId(entry.origin)) return false;
    const clone: Record<string, unknown> = { ...entry };
    delete clone["sig"];
    return await verifyBytes(entry.pubkey, entry.sig, utf8Encode(canonicalJson(clone)));
  } catch {
    return false;
  }
}

export class GSetLog {
  private entries = new Map<string, LogEntry>();
  /** origin -> highest contiguous-agnostic max seq seen */
  private vv: VersionVector = {};
  lamport = 0;

  constructor(private readonly origin: string) {}

  append(kind: string, data: unknown, ts = nowSeconds()): LogEntry {
    this.lamport += 1;
    const seq = (this.vv[this.origin] ?? 0) + 1;
    const entry: LogEntry = {
      id: `${this.origin}:${seq}`,
      origin: this.origin,
      seq,
      lamport: this.lamport,
      ts,
      kind,
      data,
    };
    this.entries.set(entry.id, entry);
    this.vv[this.origin] = seq;
    return entry;
  }

  /** Merge remote entries; returns the entries that were new to us. */
  merge(remote: LogEntry[]): LogEntry[] {
    const added: LogEntry[] = [];
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
  ordered(): LogEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** Snapshot of our per-origin high-water marks. */
  versionVector(): VersionVector {
    return { ...this.vv };
  }

  /**
   * Delta for a peer that has seen `remote` (their version vector): every
   * entry whose seq exceeds their mark for its origin. Unlike a lamport
   * watermark, this cannot skip entries from origins the peer has never
   * heard of.
   */
  entriesMissingFrom(remote: VersionVector): LogEntry[] {
    return this.ordered().filter((entry) => entry.seq > (remote[entry.origin] ?? 0));
  }

  size(): number {
    return this.entries.size;
  }

  toJSON(): LogEntry[] {
    return this.ordered();
  }

  static fromJSON(origin: string, entries: LogEntry[]): GSetLog {
    const log = new GSetLog(origin);
    log.merge(entries ?? []);
    return log;
  }
}

// ---------------------------------------------------------------------------
// LWW map with signed cells
// ---------------------------------------------------------------------------

export interface LwwCell {
  value: unknown;
  lamport: number;
  replica: string;
  /** writer's public key; sha256(pubkey) must equal replica */
  pubkey?: string;
  /** signature over canonical {key, value, lamport, replica} */
  sig?: string;
}

export async function signCell(
  privateKey: CryptoKey,
  publicKeyHex: string,
  key: string,
  cell: LwwCell,
): Promise<LwwCell> {
  cell.pubkey = publicKeyHex;
  cell.sig = await signBytes(
    privateKey,
    utf8Encode(canonicalJson({ key, value: cell.value, lamport: cell.lamport, replica: cell.replica })),
  );
  return cell;
}

/**
 * A cell is authentic when its signature verifies against its embedded
 * pubkey, that pubkey hashes to the writing replica's node id, and the key
 * lives in the writer's own namespace (`<field>/<node_id>`), so nodes can
 * only write their own profile fields.
 */
export async function verifyCell(key: string, cell: LwwCell): Promise<boolean> {
  try {
    if (!cell || typeof cell.pubkey !== "string" || typeof cell.sig !== "string") return false;
    if (typeof cell.replica !== "string") return false;
    const nodeId = replicaNodeId(cell.replica);
    if ((await sha256Hex(hexToBytes(cell.pubkey))) !== nodeId) return false;
    if (!key.endsWith(`/${nodeId}`)) return false;
    return await verifyBytes(
      cell.pubkey,
      cell.sig,
      utf8Encode(canonicalJson({ key, value: cell.value, lamport: cell.lamport, replica: cell.replica })),
    );
  } catch {
    return false;
  }
}

export class LwwMap {
  private cells = new Map<string, LwwCell>();
  lamport = 0;

  constructor(private readonly replica: string) {}

  set(key: string, value: unknown): LwwCell {
    this.lamport += 1;
    const cell: LwwCell = { value, lamport: this.lamport, replica: this.replica };
    this.cells.set(key, cell);
    return cell;
  }

  get(key: string): unknown {
    return this.cells.get(key)?.value;
  }

  getCell(key: string): LwwCell | undefined {
    return this.cells.get(key);
  }

  /** Merge remote cells; returns keys whose value changed locally. */
  merge(remote: Record<string, LwwCell>): string[] {
    const changed: string[] = [];
    for (const [key, cell] of Object.entries(remote ?? {})) {
      if (!cell || typeof cell.lamport !== "number") continue;
      if (cell.lamport > this.lamport) this.lamport = cell.lamport;
      const current = this.cells.get(key);
      if (
        !current ||
        cell.lamport > current.lamport ||
        (cell.lamport === current.lamport && cell.replica > current.replica)
      ) {
        if (!current || current.value !== cell.value) changed.push(key);
        this.cells.set(key, cell);
      }
    }
    return changed;
  }

  changedSince(lamport: number): Record<string, LwwCell> {
    const out: Record<string, LwwCell> = {};
    for (const [key, cell] of this.cells) {
      if (cell.lamport > lamport) out[key] = cell;
    }
    return out;
  }

  toJSON(): Record<string, LwwCell> {
    return Object.fromEntries(this.cells);
  }

  static fromJSON(replica: string, cells: Record<string, LwwCell>): LwwMap {
    const map = new LwwMap(replica);
    map.merge(cells ?? {});
    return map;
  }
}
