/**
 * Trust score / local reputation (design doc §14.4, Phase 4 「信頼スコア」).
 *
 * Each node keeps a purely LOCAL score per peer — there is no consensus and
 * no gossip of scores, so reputation cannot itself be attacked as a shared
 * data structure. Scores react to observed behavior:
 *
 *   + successful DataChannel connections, valid synced entries, served files
 *   - forged/unsigned CRDT entries, malformed revocation records,
 *     failed file transfers, dead keepalives
 *
 * Uses:
 *   - peers at or below BAN_THRESHOLD are ignored entirely (no connections,
 *     no message processing) until the operator resets the score
 *   - file downloads try higher-scored providers first
 *   - the UI surfaces the score so humans can see who misbehaves
 *
 * Scores decay toward zero on every restart, so a peer that had transient
 * problems (or a stale ban) heals over time instead of being punished
 * forever.
 */

export interface PeerScore {
  node_id: string;
  score: number;
  good: number;
  bad: number;
  updated_at: number;
}

export const SCORE_MIN = -100;
export const SCORE_MAX = 100;
export const BAN_THRESHOLD = -50;
/** multiplier applied when a persisted score set is loaded (per restart) */
export const DECAY = 0.9;

export type ReputationEvent =
  | "connect"
  | "valid-sync"
  | "file-served"
  | "forged-entry"
  | "bad-revocation"
  | "file-failed"
  | "keepalive-timeout"
  | "pc-failed";

export const EVENT_DELTAS: Record<ReputationEvent, number> = {
  connect: +2,
  "valid-sync": +0.2,
  "file-served": +3,
  "forged-entry": -5,
  "bad-revocation": -3,
  "file-failed": -3,
  "keepalive-timeout": -2,
  "pc-failed": -1,
};

export class Reputation {
  private scores = new Map<string, PeerScore>();
  /** invoked (debounced by the caller) whenever a score changes */
  onChange?: (record: PeerScore) => void;

  record(nodeId: string, event: ReputationEvent, now = Math.floor(Date.now() / 1000)): PeerScore {
    const delta = EVENT_DELTAS[event];
    let entry = this.scores.get(nodeId);
    if (!entry) {
      entry = { node_id: nodeId, score: 0, good: 0, bad: 0, updated_at: now };
      this.scores.set(nodeId, entry);
    }
    entry.score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, entry.score + delta));
    if (delta >= 0) entry.good += 1;
    else entry.bad += 1;
    entry.updated_at = now;
    this.onChange?.(entry);
    return entry;
  }

  scoreOf(nodeId: string): number {
    return this.scores.get(nodeId)?.score ?? 0;
  }

  get(nodeId: string): PeerScore | undefined {
    return this.scores.get(nodeId);
  }

  isBanned(nodeId: string): boolean {
    return this.scoreOf(nodeId) <= BAN_THRESHOLD;
  }

  /** Sort node ids by score, best first (stable for equal scores). */
  rank(nodeIds: string[]): string[] {
    return [...nodeIds].sort((a, b) => this.scoreOf(b) - this.scoreOf(a));
  }

  reset(nodeId?: string): void {
    if (nodeId) this.scores.delete(nodeId);
    else this.scores.clear();
  }

  all(): PeerScore[] {
    return [...this.scores.values()].sort((a, b) => b.score - a.score);
  }

  toJSON(): PeerScore[] {
    return this.all();
  }

  /**
   * Load persisted scores, applying restart decay so old grudges (and stale
   * praise) fade: score *= DECAY, and entries that have decayed to ~0 with no
   * recent activity are dropped.
   */
  static fromJSON(records: PeerScore[], decay = DECAY): Reputation {
    const rep = new Reputation();
    for (const record of records ?? []) {
      if (!record || typeof record.node_id !== "string" || typeof record.score !== "number") continue;
      const score = record.score * decay;
      if (Math.abs(score) < 0.5) continue;
      rep.scores.set(record.node_id, { ...record, score });
    }
    return rep;
  }
}
