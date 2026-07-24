/**
 * Node discovery: candidate scoring and deterministic selection.
 * Implements the discovery spec §8 ("ノード探索アルゴリズム").
 *
 *   score = invite_match_weight
 *         + freshness_weight
 *         + heartbeat_weight
 *         + relay_diversity_weight
 *         + latency_weight
 *
 * and §8.3 Step 5: the highest score wins; ties are broken by Node ID in
 * lexicographic order — NOT randomly — so every client that sees the same
 * candidate set converges on the same ordering.
 *
 * This module is pure (no I/O, no clock of its own) so the policy is unit
 * testable and identical in every node.
 */

import { HEARTBEAT_TTL, JOIN_TTL } from "./events.js";
import type { Capability, NodeId, PubKeyHex } from "./types.js";

/** One discovery candidate, assembled from relay events + local observations. */
export interface Candidate {
  node_id: NodeId;
  pubkey: PubKeyHex;
  /** created_at of the newest valid JOIN we have for this node */
  join_at: number;
  /** created_at of the newest HEARTBEAT (0 when we've never seen one) */
  heartbeat_at: number;
  /** how many DISTINCT relays reported this candidate (§8.3 relay diversity) */
  relay_count: number;
  /** measured round-trip in ms, or undefined when unknown */
  latency_ms?: number;
  /** the candidate's invite chain roots at the same issuer as ours (§8.3) */
  invite_match: boolean;
  capabilities?: Capability[];
  /** learned only through a peer table, never seen on a relay (§10.3) */
  via_peer_table?: boolean;
}

/** Weights for the five score terms. Tuned so invite match dominates and
 * liveness (heartbeat/freshness) outranks convenience (latency/diversity). */
export const WEIGHTS = {
  invite: 40,
  freshness: 25,
  heartbeat: 20,
  relayDiversity: 10,
  latency: 15,
} as const;

/** Latency at or above this is scored as "bad" (ms). */
const LATENCY_CEILING_MS = 500;
/** Unknown latency scores neutral — neither rewarded nor punished. */
const LATENCY_UNKNOWN = 0.5;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Linear decay from 1 (just now) to 0 (older than `ttl`). */
function decay(at: number, now: number, ttl: number): number {
  if (!at) return 0;
  return clamp01(1 - (now - at) / ttl);
}

export function scoreCandidate(c: Candidate, now: number): number {
  const invite = c.invite_match ? WEIGHTS.invite : 0;
  const freshness = WEIGHTS.freshness * decay(c.join_at, now, JOIN_TTL);
  const heartbeat = WEIGHTS.heartbeat * decay(c.heartbeat_at, now, HEARTBEAT_TTL);
  // 1 relay = no bonus, 3+ relays = full bonus (agreement across relays, §14.3)
  const diversity = WEIGHTS.relayDiversity * clamp01((c.relay_count - 1) / 2);
  const latency =
    WEIGHTS.latency *
    (c.latency_ms === undefined ? LATENCY_UNKNOWN : clamp01(1 - c.latency_ms / LATENCY_CEILING_MS));
  return invite + freshness + heartbeat + diversity + latency;
}

export interface RankedCandidate extends Candidate {
  score: number;
}

/**
 * Rank candidates best-first. Deterministic: equal scores fall back to
 * ascending node_id (§8.3 Step 5), so all clients agree on the order.
 */
export function rankCandidates(candidates: Candidate[], now: number): RankedCandidate[] {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, now) }))
    .sort((a, b) => {
      // round to 6 decimals so float noise can't flip an otherwise-exact tie
      const d = Math.round((b.score - a.score) * 1e6);
      if (d !== 0) return d;
      return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
    });
}

/** The single best candidate (§8.3 Step 5), or undefined when none are known. */
export function selectCandidate(candidates: Candidate[], now: number): RankedCandidate | undefined {
  return rankCandidates(candidates, now)[0];
}

/**
 * Candidate is worth attempting at all: we've seen it alive recently, either
 * through a relay (JOIN/HEARTBEAT within TTL) or a peer table introduction.
 */
export function isViable(c: Candidate, now: number): boolean {
  if (c.via_peer_table && now - c.join_at <= JOIN_TTL) return true;
  return decay(c.join_at, now, JOIN_TTL) > 0 || decay(c.heartbeat_at, now, HEARTBEAT_TTL) > 0;
}
