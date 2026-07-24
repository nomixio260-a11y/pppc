import { test } from "node:test";
import assert from "node:assert/strict";
import { BAN_THRESHOLD, Reputation, SCORE_MAX, SCORE_MIN } from "../src/shared/reputation.js";

test("positive and negative events move the score and are clamped", () => {
  const rep = new Reputation();
  rep.record("a", "connect"); // +2
  rep.record("a", "file-served"); // +3
  assert.equal(rep.scoreOf("a"), 5);

  // clamp at max
  for (let i = 0; i < 200; i++) rep.record("a", "file-served");
  assert.equal(rep.scoreOf("a"), SCORE_MAX);

  // clamp at min
  const rep2 = new Reputation();
  for (let i = 0; i < 200; i++) rep2.record("b", "forged-entry");
  assert.equal(rep2.scoreOf("b"), SCORE_MIN);
});

test("a peer that forges enough entries gets banned", () => {
  const rep = new Reputation();
  assert.equal(rep.isBanned("m"), false);
  // each forged-entry is -5; banning at <= -50 needs 10
  for (let i = 0; i < 10; i++) rep.record("m", "forged-entry");
  assert.ok(rep.scoreOf("m") <= BAN_THRESHOLD);
  assert.equal(rep.isBanned("m"), true);
});

test("rank orders peers by score, best first", () => {
  const rep = new Reputation();
  rep.record("low", "forged-entry"); // -5
  rep.record("high", "file-served"); // +3
  rep.record("high", "file-served"); // +6
  rep.record("mid", "connect"); // +2
  assert.deepEqual(rep.rank(["low", "mid", "high"]), ["high", "mid", "low"]);
});

test("reset clears a single peer or everyone", () => {
  const rep = new Reputation();
  rep.record("a", "file-served");
  rep.record("b", "file-served");
  rep.reset("a");
  assert.equal(rep.scoreOf("a"), 0);
  assert.equal(rep.scoreOf("b"), 3);
  rep.reset();
  assert.equal(rep.scoreOf("b"), 0);
});

test("persistence decays scores on restart and drops near-zero entries", () => {
  const rep = new Reputation();
  rep.record("a", "file-served"); // +3
  rep.record("tiny", "valid-sync"); // +0.2
  const json = rep.toJSON();

  const revived = Reputation.fromJSON(json, 0.9);
  // 3 * 0.9 = 2.7 retained
  assert.ok(Math.abs(revived.scoreOf("a") - 2.7) < 1e-9);
  // 0.2 * 0.9 = 0.18 < 0.5 threshold -> dropped
  assert.equal(revived.scoreOf("tiny"), 0);
});

test("onChange fires for persistence", () => {
  const rep = new Reputation();
  const seen: string[] = [];
  rep.onChange = (r) => seen.push(r.node_id);
  rep.record("a", "connect");
  rep.record("b", "connect");
  rep.record("a", "connect");
  assert.deepEqual(seen, ["a", "b", "a"]);
});
