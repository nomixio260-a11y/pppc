/**
 * Discovery spec §8: candidate scoring and deterministic selection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHTS,
  isViable,
  rankCandidates,
  scoreCandidate,
  selectCandidate,
  selectConnectTargets,
  normalizeRelayUrl,
  selectRelayHints,
  type Candidate,
} from "../src/shared/discovery.js";
import { HEARTBEAT_TTL, JOIN_TTL } from "../src/shared/events.js";

const NOW = 1_800_000_000;
const base = (over: Partial<Candidate> = {}): Candidate => ({
  node_id: "aa".repeat(32),
  pubkey: "04".padEnd(130, "0"),
  join_at: NOW,
  heartbeat_at: NOW,
  relay_count: 1,
  invite_match: false,
  ...over,
});

test("each score term contributes as specified", () => {
  // fresh JOIN+HEARTBEAT, single relay, unknown latency, no invite match
  const plain = scoreCandidate(base(), NOW);
  assert.ok(Math.abs(plain - (WEIGHTS.freshness + WEIGHTS.heartbeat + WEIGHTS.latency * 0.5)) < 1e-9);

  // invite match adds its full weight
  assert.ok(Math.abs(scoreCandidate(base({ invite_match: true }), NOW) - (plain + WEIGHTS.invite)) < 1e-9);

  // three relays = full diversity bonus
  assert.ok(
    Math.abs(scoreCandidate(base({ relay_count: 3 }), NOW) - (plain + WEIGHTS.relayDiversity)) < 1e-9,
  );

  // zero latency beats unknown, which beats a slow peer
  const fast = scoreCandidate(base({ latency_ms: 0 }), NOW);
  const slow = scoreCandidate(base({ latency_ms: 500 }), NOW);
  assert.ok(fast > plain && plain > slow);
});

test("freshness and heartbeat decay to zero at their TTLs", () => {
  const stale = base({ join_at: NOW - JOIN_TTL, heartbeat_at: NOW - HEARTBEAT_TTL });
  assert.ok(Math.abs(scoreCandidate(stale, NOW) - WEIGHTS.latency * 0.5) < 1e-9);
  // half-way through the TTL yields about half the weight
  const half = base({ join_at: NOW - JOIN_TTL / 2, heartbeat_at: 0 });
  assert.ok(Math.abs(scoreCandidate(half, NOW) - (WEIGHTS.freshness / 2 + WEIGHTS.latency * 0.5)) < 1e-6);
});

test("a live, invite-matching, multi-relay candidate outranks a stale one", () => {
  const good = base({ node_id: "ff".repeat(32), invite_match: true, relay_count: 3, latency_ms: 20 });
  const weak = base({ node_id: "00".repeat(32), join_at: NOW - JOIN_TTL * 0.9, heartbeat_at: 0 });
  const ranked = rankCandidates([weak, good], NOW);
  assert.equal(ranked[0]!.node_id, good.node_id);
  assert.equal(selectCandidate([weak, good], NOW)?.node_id, good.node_id);
});

test("ties break on node_id lexicographically — not randomly (§8.3 Step 5)", () => {
  // identical observations, different ids: order must be by id ascending
  const ids = ["cc", "aa", "bb"].map((p) => p.repeat(32));
  const cands = ids.map((node_id) => base({ node_id }));
  const first = rankCandidates(cands, NOW).map((c) => c.node_id);
  assert.deepEqual(first, [...ids].sort());

  // and the order is stable across shuffles: every client agrees
  for (const perm of [[2, 0, 1], [1, 2, 0], [0, 2, 1]]) {
    const shuffled = perm.map((i) => cands[i]!);
    assert.deepEqual(
      rankCandidates(shuffled, NOW).map((c) => c.node_id),
      first,
      "ranking must not depend on input order",
    );
  }
});

test("viability: expired relay sightings drop out, peer-table intros stay", () => {
  assert.equal(isViable(base(), NOW), true);
  const expired = base({ join_at: NOW - JOIN_TTL - 1, heartbeat_at: NOW - HEARTBEAT_TTL - 1 });
  assert.equal(isViable(expired, NOW), false);
  // a peer-table introduction is viable even with no relay sighting (§10.3)
  const introduced = base({ join_at: NOW - 10, heartbeat_at: 0, relay_count: 0, via_peer_table: true });
  assert.equal(isViable(introduced, NOW), true);
});

test("selectCandidate returns undefined with no candidates", () => {
  assert.equal(selectCandidate([], NOW), undefined);
});

// ---------------------------------------------------------------------------
// Bounded-degree connect selection (§8.3 Step 5 + §12.2)
// ---------------------------------------------------------------------------

test("connect targets respect the link cap and take the best first", () => {
  const ranked = ["a", "b", "c", "d"].map((n) => ({ node_id: n.repeat(64) }));
  // no links yet, cap 2 -> the two best
  const first = selectConnectTargets(ranked, { active: new Set(), maxLinks: 2 });
  assert.deepEqual(first, [ranked[0]!.node_id, ranked[1]!.node_id]);

  // one slot already used -> only the next best is chosen, no duplicates
  const second = selectConnectTargets(ranked, { active: new Set([ranked[0]!.node_id]), maxLinks: 2 });
  assert.deepEqual(second, [ranked[1]!.node_id]);

  // at capacity -> nothing new
  assert.deepEqual(
    selectConnectTargets(ranked, { active: new Set([ranked[0]!.node_id, ranked[1]!.node_id]), maxLinks: 2 }),
    [],
  );
});

test("a freed slot promotes the next-best candidate (§12.2)", () => {
  const ranked = ["a", "b", "c"].map((n) => ({ node_id: n.repeat(64) }));
  // b failed and is skipped; the freed slot goes to c, not back to b
  const targets = selectConnectTargets(ranked, {
    active: new Set([ranked[0]!.node_id]),
    maxLinks: 2,
    skip: (id) => id === ranked[1]!.node_id,
  });
  assert.deepEqual(targets, [ranked[2]!.node_id]);
});

// ---------------------------------------------------------------------------
// Relay hints learned from peers (§12.1 relay failover)
// ---------------------------------------------------------------------------

test("relay URLs from peers are normalized, and non-relay URLs rejected", () => {
  assert.equal(normalizeRelayUrl("ws://relay.example:8787/"), "ws://relay.example:8787");
  assert.equal(normalizeRelayUrl("  wss://relay.example/anp/  "), "wss://relay.example/anp");
  // the same relay under two spellings must collapse to one entry
  assert.equal(normalizeRelayUrl("wss://relay.example/#x"), normalizeRelayUrl("wss://relay.example"));
  // anything that isn't a plain ws/wss relay is refused
  for (const bad of [
    "http://relay.example",
    "javascript:alert(1)",
    "wss://user:pw@relay.example", // credentials in a peer-supplied URL
    "file:///etc/passwd",
    "not a url",
    123,
    null,
    "wss://relay.example/" + "a".repeat(300),
  ]) {
    assert.equal(normalizeRelayUrl(bad), undefined, `should reject ${String(bad).slice(0, 30)}`);
  }
});

test("relay hints need a quorum, skip known relays and stay bounded", () => {
  const p = (n: string) => n.repeat(64);
  const hints = new Map([
    ["wss://one.example", new Set([p("a"), p("b")])], // 2 peers
    ["wss://two.example", new Set([p("a")])], // 1 peer
    ["wss://known.example", new Set([p("a"), p("b"), p("c")])], // already ours
  ]);

  // quorum 2: the single-peer hint is ignored, our own relay is not re-added
  assert.deepEqual(selectRelayHints(hints, { known: ["wss://known.example/"], quorum: 2 }), [
    "wss://one.example",
  ]);

  // quorum 1: both unknown hints, most-advertised first (deterministic)
  assert.deepEqual(selectRelayHints(hints, { known: ["wss://known.example"], quorum: 1 }), [
    "wss://one.example",
    "wss://two.example",
  ]);

  // the total relay count is capped, so a peer can't flood our relay list
  assert.deepEqual(selectRelayHints(hints, { known: ["wss://known.example"], quorum: 1, max: 2 }), [
    "wss://one.example",
  ]);
  assert.deepEqual(selectRelayHints(hints, { known: ["wss://known.example"], quorum: 1, max: 1 }), []);
});

test("hint ties break deterministically by URL, not by insertion order", () => {
  const p = (n: string) => n.repeat(64);
  const peers = () => new Set([p("a"), p("b")]);
  const forward = new Map([
    ["wss://b.example", peers()],
    ["wss://a.example", peers()],
  ]);
  const reverse = new Map([...forward.entries()].reverse());
  const opts = { known: [] as string[], quorum: 2 };
  assert.deepEqual(selectRelayHints(forward, opts), ["wss://a.example", "wss://b.example"]);
  assert.deepEqual(selectRelayHints(reverse, opts), selectRelayHints(forward, opts));
});
