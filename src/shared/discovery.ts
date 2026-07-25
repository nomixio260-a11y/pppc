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

/**
 * Which peers to open links to next, best-first (§8.3 Step 5 + §12.2).
 *
 * The mesh keeps a bounded degree: a channel with 50 people must not become
 * 50² connections. We hold at most `maxLinks` links, filled from the ranked
 * candidate list; when one fails or drops, the next-best candidate takes the
 * free slot ("次点の候補へ進む"). Messages still reach everyone because CRDT
 * deltas are gossiped across the partial mesh.
 */
export function selectConnectTargets(
  ranked: Array<{ node_id: NodeId }>,
  opts: { active: Set<NodeId>; maxLinks: number; skip?: (id: NodeId) => boolean },
): NodeId[] {
  const free = opts.maxLinks - opts.active.size;
  if (free <= 0) return [];
  const out: NodeId[] = [];
  for (const c of ranked) {
    if (out.length >= free) break;
    if (opts.active.has(c.node_id)) continue;
    if (opts.skip?.(c.node_id)) continue;
    out.push(c.node_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relay hints (§12.1 relay failover)
// ---------------------------------------------------------------------------

/** How many relay URLs a node advertises in its peer-table row. */
export const MAX_ADVERTISED_RELAYS = 4;
/** Hard ceiling on a node's relay list, hints included. */
export const MAX_TOTAL_RELAYS = 8;

/**
 * Normalize a relay URL for comparison and storage, or return undefined when
 * it isn't a relay URL we'd ever dial. Only ws/wss, no credentials, no
 * fragment, and a trailing slash is insignificant — so a peer can't get the
 * same relay adopted twice under two spellings.
 */
export function normalizeRelayUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 200) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
  if (u.username || u.password) return undefined;
  if (!u.hostname) return undefined;
  u.hash = "";
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Pick relay URLs advertised by peers that are worth adopting (§12.1).
 *
 * Adoption is deliberately conservative, because a URL from a peer is
 * attacker-controlled input:
 *  - it is purely ADDITIVE — the node's own relays are never replaced, so a
 *    hostile hint cannot eclipse anyone (and every event is verified locally,
 *    so a relay can withhold but never forge)
 *  - a hint counts only when at least `quorum` DISTINCT peers advertise it,
 *    so one lying peer cannot steer us
 *  - the total relay count stays bounded
 *
 * `hints` maps a normalized URL to the set of node ids that advertised it.
 * The result is deterministic: most-advertised first, ties by URL.
 */
export function selectRelayHints(
  hints: Map<string, Set<NodeId>>,
  opts: { known: Iterable<string>; quorum: number; max?: number },
): string[] {
  const known = new Set<string>();
  for (const url of opts.known) {
    const n = normalizeRelayUrl(url);
    if (n) known.add(n);
  }
  const room = (opts.max ?? MAX_TOTAL_RELAYS) - known.size;
  if (room <= 0) return [];
  return [...hints.entries()]
    .filter(([url, peers]) => peers.size >= opts.quorum && !known.has(url))
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, room)
    .map(([url]) => url);
}
