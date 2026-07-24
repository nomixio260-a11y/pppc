import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "../src/shared/crypto.js";
import { issueCertificate, networkIdFromGenesisPubkey } from "../src/shared/identity.js";
import {
  createHeartbeat,
  createJoin,
  createLeave,
  createManifest,
  createSignal,
  verifyEvent,
} from "../src/shared/events.js";
import type { JoinEvent, SignalEvent } from "../src/shared/types.js";

async function makeMember() {
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join", "invite", "chat", "store"],
  });
  return { genesis, node, networkId, chain: [cert] };
}

test("JOIN with a valid invite chain verifies", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain, "alice");
  const result = await verifyEvent(join);
  assert.equal(result.ok, true, result.reason);
});

test("JOIN without an invite chain is rejected", async () => {
  const { node, networkId } = await makeMember();
  const join = await createJoin(networkId, node, []);
  const result = await verifyEvent(join);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /invite chain/);
});

test("JOIN with a chain for a different network is rejected", async () => {
  const { node, chain } = await makeMember();
  const otherGenesis = await generateKeyPair();
  const otherNetwork = await networkIdFromGenesisPubkey(otherGenesis.publicKeyHex);
  const join = await createJoin(otherNetwork, node, chain);
  assert.equal((await verifyEvent(join)).ok, false);
});

test("tampered event body fails id/signature check", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = (await createJoin(networkId, node, chain, "alice")) as JoinEvent;
  const tampered = { ...join, body: { ...join.body, nickname: "mallory" } } as JoinEvent;
  assert.equal((await verifyEvent(tampered)).ok, false);
});

test("event signed by a different key is rejected", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = (await createJoin(networkId, node, chain)) as JoinEvent;
  const attacker = await generateKeyPair();
  const stolen = { ...join, pubkey: attacker.publicKeyHex } as JoinEvent;
  assert.equal((await verifyEvent(stolen)).ok, false);
});

test("expired events are rejected", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain);
  const future = join.expires_at + 1;
  assert.equal((await verifyEvent(join, { now: future })).ok, false);
});

test("HEARTBEAT / LEAVE / MANIFEST / SIGNAL verify", async () => {
  const { node, networkId } = await makeMember();
  const other = await generateKeyPair();
  assert.equal((await verifyEvent(await createHeartbeat(networkId, node))).ok, true);
  assert.equal((await verifyEvent(await createLeave(networkId, node))).ok, true);
  assert.equal(
    (await verifyEvent(await createManifest(networkId, node, { relays: [], records: [] }))).ok,
    true,
  );
  const signal = (await createSignal(networkId, node, "f".repeat(64), other.publicKeyHex, "s1", 0, {
    kind: "offer",
    sdp: "v=0...",
  })) as SignalEvent;
  assert.equal((await verifyEvent(signal)).ok, true);
  assert.equal(signal.body.target, "f".repeat(64));
  assert.equal(typeof signal.body.enc.ct, "string");
});
