/**
 * Open rooms: invite-less JOIN bound to a room name (default discovery mode).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "../src/shared/crypto.js";
import { normalizeRoom, openNetworkId } from "../src/shared/identity.js";
import { POW_BITS, createJoin, verifyEvent } from "../src/shared/events.js";
import type { JoinEvent } from "../src/shared/types.js";

test("openNetworkId is deterministic and room names normalize", async () => {
  const a = await openNetworkId(normalizeRoom("  Lobby  "));
  const b = await openNetworkId(normalizeRoom("lobby"));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(await openNetworkId("lobby"), await openNetworkId("other"));
});

test("an open JOIN verifies with only signature + PoW (no invite chain)", async () => {
  const node = await generateKeyPair();
  const room = "lobby";
  const networkId = await openNetworkId(room);
  const join = (await createJoin(networkId, node, [], { open: true, room, nickname: "alice" })) as JoinEvent;
  const result = await verifyEvent(join, { powBits: POW_BITS });
  assert.equal(result.ok, true, result.reason);
  assert.equal(join.body.open, true);
  assert.equal(join.body.room, room);
});

test("an open JOIN whose network_id does not match the room is rejected", async () => {
  const node = await generateKeyPair();
  const room = "lobby";
  const wrongNetwork = await openNetworkId("different-room");
  const join = await createJoin(wrongNetwork, node, [], { open: true, room });
  const result = await verifyEvent(join, { powBits: POW_BITS });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /room does not match/);
});

test("an open JOIN cannot slip into an invite-only network", async () => {
  // an invite-only network id (hash of a genesis pubkey) will not equal
  // openNetworkId(room) for any room, so declaring open:true fails
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const { networkIdFromGenesisPubkey } = await import("../src/shared/identity.js");
  const inviteNetwork = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const join = await createJoin(inviteNetwork, node, [], { open: true, room: "anything" });
  const result = await verifyEvent(join, { powBits: POW_BITS });
  assert.equal(result.ok, false);
});

test("a non-open JOIN still requires an invite chain", async () => {
  const node = await generateKeyPair();
  const room = "lobby";
  const networkId = await openNetworkId(room);
  // same network, but not declaring open -> falls back to invite-chain check
  const join = await createJoin(networkId, node, [], { nickname: "x" });
  const result = await verifyEvent(join, { powBits: POW_BITS });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /invite chain/);
});

test("open JOIN still enforces proof-of-work", async () => {
  const node = await generateKeyPair();
  const room = "lobby";
  const networkId = await openNetworkId(room);
  let rejected = false;
  for (let i = 0; i < 3 && !rejected; i++) {
    const weak = await createJoin(networkId, node, [], { open: true, room, powBits: 0 });
    const r = await verifyEvent(weak, { powBits: 20 });
    rejected = !r.ok && /proof-of-work/.test(r.reason ?? "");
  }
  assert.ok(rejected);
});
