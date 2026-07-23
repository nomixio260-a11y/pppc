import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, canonicalJson, sha256Hex } from "../src/shared/crypto.js";
import {
  anpUrl,
  decodeInviteBundle,
  encodeInviteBundle,
  issueCertificate,
  networkIdFromGenesisPubkey,
  nodeIdFromPubkey,
  parseAnpUrl,
  verifyCertificate,
  verifyInviteChain,
} from "../src/shared/identity.js";
import type { InviteBundle } from "../src/shared/types.js";

test("canonical json sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
});

test("network id is deterministic and forms the fixed url", async () => {
  const genesis = await generateKeyPair();
  const id1 = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const id2 = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  assert.equal(id1, id2);
  assert.match(id1, /^[0-9a-f]{64}$/);
  assert.equal(parseAnpUrl(anpUrl(id1)), id1);
});

test("node id is sha256 of node pubkey", async () => {
  const node = await generateKeyPair();
  const id = await nodeIdFromPubkey(node.publicKeyHex);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test("certificate signs and verifies; tampering breaks it", async () => {
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join", "chat"],
  });
  assert.equal(await verifyCertificate(cert), true);
  assert.equal(await verifyCertificate({ ...cert, rights: ["join", "chat", "admin"] }), false);
  assert.equal(await verifyCertificate({ ...cert, revoked: true }), false);
  assert.equal(await verifyCertificate({ ...cert, expires_at: 1 }), false);
});

test("invite chain: genesis-issued single link", async () => {
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join", "chat"],
  });
  const result = await verifyInviteChain(networkId, [cert], node.publicKeyHex);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rights, ["join", "chat"]);
});

test("invite chain: delegated two-link chain requires invite right", async () => {
  const genesis = await generateKeyPair();
  const alice = await generateKeyPair();
  const bob = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);

  const aliceCert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: alice.publicKeyHex,
    rights: ["join", "invite", "chat"],
  });
  const bobCert = await issueCertificate({
    networkId,
    issuer: alice,
    subjectPubkey: bob.publicKeyHex,
    rights: ["join", "chat"],
  });
  const ok = await verifyInviteChain(networkId, [aliceCert, bobCert], bob.publicKeyHex);
  assert.equal(ok.ok, true);

  // alice without invite right cannot delegate
  const aliceNoInvite = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: alice.publicKeyHex,
    rights: ["join", "chat"],
  });
  const bad = await verifyInviteChain(networkId, [aliceNoInvite, bobCert], bob.publicKeyHex);
  assert.equal(bad.ok, false);
});

test("invite chain: rejected for wrong network / wrong subject / forged root", async () => {
  const genesis = await generateKeyPair();
  const other = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);

  // forged root: signed by a non-genesis key
  const forged = await issueCertificate({
    networkId,
    issuer: other,
    subjectPubkey: node.publicKeyHex,
    rights: ["join"],
  });
  assert.equal((await verifyInviteChain(networkId, [forged], node.publicKeyHex)).ok, false);

  // wrong subject
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join"],
  });
  assert.equal((await verifyInviteChain(networkId, [cert], other.publicKeyHex)).ok, false);

  // empty chain from a non-genesis node
  assert.equal((await verifyInviteChain(networkId, [], node.publicKeyHex)).ok, false);
});

test("genesis node itself joins without a chain", async () => {
  const genesis = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const result = await verifyInviteChain(networkId, [], genesis.publicKeyHex);
  assert.equal(result.ok, true);
  assert.ok(result.rights.includes("admin"));
});

test("invite bundle round-trips", async () => {
  const genesis = await generateKeyPair();
  const node = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const cert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: node.publicKeyHex,
    rights: ["join"],
  });
  const bundle: InviteBundle = {
    v: 1,
    network_id: networkId,
    genesis_pubkey: genesis.publicKeyHex,
    relays: ["ws://localhost:8787"],
    chain: [cert],
  };
  const decoded = decodeInviteBundle(encodeInviteBundle(bundle));
  assert.deepEqual(decoded, bundle);
});

test("sha256 hex matches a known vector", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
