import { test } from "node:test";
import assert from "node:assert/strict";
import { GSetLog, LwwMap } from "../src/shared/crdt.js";

test("GSetLog: replicas converge to the same order regardless of delivery", () => {
  const a = new GSetLog("aaaa");
  const b = new GSetLog("bbbb");

  const a1 = a.append("chat", { text: "hi from a" }, 100);
  const b1 = b.append("chat", { text: "hi from b" }, 100);
  b.merge([a1]);
  const b2 = b.append("chat", { text: "reply" }, 101);
  a.merge([b1, b2]);
  b.merge(a.ordered()); // idempotent re-merge

  assert.deepEqual(
    a.ordered().map((e) => e.id),
    b.ordered().map((e) => e.id),
  );
  assert.equal(a.size(), 3);
  // b2 causally follows a1, so it sorts after it
  const order = a.ordered().map((e) => e.id);
  assert.ok(order.indexOf(a1.id) < order.indexOf(b2.id));
});

test("GSetLog: merge is idempotent and reports only new entries", () => {
  const a = new GSetLog("aaaa");
  const e = a.append("chat", { text: "x" }, 1);
  const b = new GSetLog("bbbb");
  assert.equal(b.merge([e]).length, 1);
  assert.equal(b.merge([e]).length, 0);
});

test("GSetLog: version-vector delta covers unseen origins", () => {
  const a = new GSetLog("aaaa");
  const b = new GSetLog("bbbb");
  const c = new GSetLog("cccc");
  // c writes early (low lamport), a writes later (high lamport); b merges only a
  const c1 = c.append("chat", { text: "from c" }, 1);
  a.append("chat", { text: "a1" }, 2);
  a.append("chat", { text: "a2" }, 3);
  a.merge([c1]);
  b.merge(a.entriesMissingFrom(b.versionVector()));
  // b must have received c's entry even though its lamport is lower than a's max —
  // a lamport-watermark sync would have skipped it
  assert.equal(b.size(), 3);
  assert.ok(b.ordered().some((e) => e.origin === "cccc"));

  // and a delta against b's now-complete vector is empty
  assert.equal(a.entriesMissingFrom(b.versionVector()).length, 0);
});

test("GSetLog: rehydration continues seq without id collisions", () => {
  const a = new GSetLog("aaaa");
  a.append("chat", { text: "1" }, 1);
  a.append("chat", { text: "2" }, 2);
  const revived = GSetLog.fromJSON("aaaa", a.toJSON());
  const next = revived.append("chat", { text: "3" }, 3);
  assert.equal(next.id, "aaaa:3");
  assert.equal(revived.size(), 3);
});

test("LwwMap: last writer wins with deterministic tie-break", () => {
  const a = new LwwMap("aaaa");
  const b = new LwwMap("bbbb");
  a.set("k", "from-a"); // lamport 1 @ aaaa
  b.set("k", "from-b"); // lamport 1 @ bbbb — tie, larger replica id wins

  a.merge(b.toJSON());
  b.merge(a.toJSON());
  assert.equal(a.get("k"), b.get("k"));
  assert.equal(a.get("k"), "from-b");

  b.set("k", "newer"); // lamport 2
  a.merge(b.changedSince(1));
  assert.equal(a.get("k"), "newer");
});

test("LwwMap: changedSince exports only newer cells", () => {
  const a = new LwwMap("aaaa");
  a.set("x", 1);
  a.set("y", 2);
  const delta = a.changedSince(1);
  assert.deepEqual(Object.keys(delta), ["y"]);
});
