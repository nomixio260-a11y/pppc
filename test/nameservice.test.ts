import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "../src/shared/crypto.js";
import { networkIdFromGenesisPubkey } from "../src/shared/identity.js";
import {
  NameServiceStore,
  createNameRecord,
  isExpired,
  pickNewer,
  verifyNameRecord,
} from "../src/shared/nameservice.js";

async function setup() {
  const genesis = await generateKeyPair();
  const keys = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  return { keys, networkId };
}

test("records sign and verify; tampering breaks them", async () => {
  const { keys, networkId } = await setup();
  const record = await createNameRecord(networkId, keys, "service/chat", { nodes: ["a"] }, 1);
  assert.equal(await verifyNameRecord(record), true);
  assert.equal(await verifyNameRecord({ ...record, version: 99 }), false);
  assert.equal(await verifyNameRecord({ ...record, value: { nodes: ["b"] } }), false);
});

test("higher version wins; same version falls back to updated_at", async () => {
  const { keys, networkId } = await setup();
  const v1 = await createNameRecord(networkId, keys, "n", "a", 1);
  const v2 = await createNameRecord(networkId, keys, "n", "b", 2);
  assert.equal(pickNewer(v1, v2), v2);
  assert.equal(pickNewer(v2, v1), v2);

  const sameA = { ...v1, updated_at: 100 };
  const sameB = { ...v1, updated_at: 200 };
  assert.equal(pickNewer(sameA, sameB), sameB);
});

test("store merges only valid, newer, same-network records", async () => {
  const { keys, networkId } = await setup();
  const store = new NameServiceStore(networkId);

  const v1 = await createNameRecord(networkId, keys, "service/chat", { nodes: ["a"] }, 1);
  const v2 = await createNameRecord(networkId, keys, "service/chat", { nodes: ["a", "b"] }, 2);

  assert.equal(await store.merge(v1), true);
  assert.equal(await store.merge(v2), true);
  assert.equal(await store.merge(v1), false); // stale version does not win
  assert.deepEqual(store.resolve("service/chat")?.value, { nodes: ["a", "b"] });

  // tampered record is discarded
  assert.equal(await store.merge({ ...v2, version: 10 }), false);

  // record for another network is discarded
  const otherGenesis = await generateKeyPair();
  const otherNet = await networkIdFromGenesisPubkey(otherGenesis.publicKeyHex);
  const foreign = await createNameRecord(otherNet, keys, "x", 1, 1);
  assert.equal(await store.merge(foreign), false);
});

test("ttl expiry", async () => {
  const { keys, networkId } = await setup();
  const record = await createNameRecord(networkId, keys, "n", "v", 1, 10);
  assert.equal(isExpired(record, record.updated_at + 5), false);
  assert.equal(isExpired(record, record.updated_at + 10), true);

  const store = new NameServiceStore(networkId);
  await store.merge(record);
  assert.equal(store.resolve("n", record.updated_at + 11), undefined);
});

test("an expired stored record never beats a fresh incoming one", async () => {
  const { keys, networkId } = await setup();
  const { signObject } = await import("../src/shared/crypto.js");
  const store = new NameServiceStore(networkId);

  // a validly-signed but already-expired v5 record, injected via load()
  const expired = await createNameRecord(networkId, keys, "n", "old", 5, 10);
  (expired as { updated_at: number }).updated_at -= 100;
  expired.signature = "";
  expired.signature = await signObject(keys.privateKey, expired as unknown as Record<string, unknown>, [
    "signature",
  ]);
  store.load([expired]);

  // a publisher that lost its state restarts at version 1 — it must win
  const fresh = await createNameRecord(networkId, keys, "n", "new", 1, 600);
  assert.equal(await store.merge(fresh), true, "fresh v1 must replace expired v5");
  assert.equal(store.resolve("n")?.value, "new");
});

test("merging an identical, already-stored record is not reported as a win", async () => {
  // guards against the gossip-storm bug: callers re-broadcast merge() winners,
  // so a converged record re-received via anti-entropy must return false or it
  // would circulate the mesh forever
  const { keys, networkId } = await setup();
  const store = new NameServiceStore(networkId);
  const record = await createNameRecord(networkId, keys, "service/chat", { nodes: ["a"] }, 1);
  assert.equal(await store.merge(record), true, "first insert wins");
  assert.equal(await store.merge(record), false, "identical re-receive is not a win");
  // a structurally-equal but re-signed newer record (different signature) does win
  const bumped = await createNameRecord(networkId, keys, "service/chat", { nodes: ["a"] }, 2);
  assert.equal(await store.merge(bumped), true, "strictly newer version wins");
  assert.equal(await store.merge(bumped), false, "and its own re-receive does not");
});

test("replicas converge regardless of merge order", async () => {
  const { keys, networkId } = await setup();
  const a = new NameServiceStore(networkId);
  const b = new NameServiceStore(networkId);
  const r1 = await createNameRecord(networkId, keys, "n", "one", 1);
  const r2 = await createNameRecord(networkId, keys, "n", "two", 2);
  const r3 = await createNameRecord(networkId, keys, "m", "x", 1);

  for (const r of [r1, r2, r3]) await a.merge(r);
  for (const r of [r3, r2, r1]) await b.merge(r);

  assert.deepEqual(a.all(), b.all());
  assert.equal(a.resolve("n")?.value, "two");
});
