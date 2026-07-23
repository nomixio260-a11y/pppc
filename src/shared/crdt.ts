/**
 * CRDTs for ANP's Data Layer (design doc §11.3).
 *
 * Two small, dependency-free CRDTs cover the MVP services:
 *
 *  - GSetLog: a grow-only set of signed-by-origin entries with a
 *    deterministic total order (lamport, then entry id). Used for
 *    `service/chat`. Merging is set union, so replicas converge regardless
 *    of delivery order or duplication.
 *
 *  - LwwMap: last-writer-wins register map keyed by string. Used for
 *    `service/profile` and peer metadata. Ties break on replica id so the
 *    merge is a total order.
 *
 * Both support delta export (`entriesSince` / `changedSince`) so peers
 * exchange only what the other side is missing.
 */

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
}

export class GSetLog {
  private entries = new Map<string, LogEntry>();
  private maxSeq = 0;
  lamport = 0;

  constructor(private readonly origin: string) {}

  append(kind: string, data: unknown, ts: number): LogEntry {
    this.lamport += 1;
    this.maxSeq += 1;
    const entry: LogEntry = {
      id: `${this.origin}:${this.maxSeq}`,
      origin: this.origin,
      seq: this.maxSeq,
      lamport: this.lamport,
      ts,
      kind,
      data,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Merge remote entries; returns the entries that were new to us. */
  merge(remote: LogEntry[]): LogEntry[] {
    const added: LogEntry[] = [];
    for (const entry of remote) {
      if (!entry || typeof entry.id !== "string" || this.entries.has(entry.id)) continue;
      this.entries.set(entry.id, entry);
      if (entry.lamport > this.lamport) this.lamport = entry.lamport;
      if (entry.origin === this.origin && entry.seq > this.maxSeq) this.maxSeq = entry.seq;
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

  /** Delta: everything with lamport > `lamport`. */
  entriesSince(lamport: number): LogEntry[] {
    return this.ordered().filter((entry) => entry.lamport > lamport);
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

export interface LwwCell {
  value: unknown;
  lamport: number;
  replica: string;
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
