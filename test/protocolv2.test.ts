/**
 * Protocol v2 features: ECIES signal encryption, JOIN proof-of-work,
 * signed CRDT entries/cells, and invite revocation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eciesDecrypt,
  eciesEncrypt,
  exportKeyPair,
  generateKeyPair,
  hasPow,
  importPrivateKeyForEcdh,
  leadingZeroBits,
  utf8Encode,
} from "../src/shared/crypto.js";
import { issueCertificate, networkIdFromGenesisPubkey, verifyInviteChain } from "../src/shared/identity.js";
import { POW_BITS, createJoin, createSignal, decryptSignal, verifyEvent } from "../src/shared/events.js";
import {
  GSetLog,
  LwwMap,
  signCell,
  signLogEntry,
  verifyCell,
  verifyLogEntry,
} from "../src/shared/crdt.js";
import { NameServiceStore, REVOKED_PREFIX, createNameRecord } from "../src/shared/nameservice.js";
import { nodeIdFromPubkey } from "../src/shared/identity.js";
import type { RevocationMap, SignalEvent } from "../src/shared/types.js";

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
  return { genesis, node, networkId, cert, chain: [cert] };
}

// ---------------------------------------------------------------------------
// ECIES
// ---------------------------------------------------------------------------

test("ECIES round-trips between two nodes", async () => {
  const recipient = await generateKeyPair();
  const stored = await exportKeyPair(recipient);
  const ecdhKey = await importPrivateKeyForEcdh(stored.privateJwk);

  const plaintext = utf8Encode(JSON.stringify({ kind: "offer", sdp: "v=0 secret" }));
  const envelope = await eciesEncrypt(recipient.publicKeyHex, plaintext);
  const decrypted = await eciesDecrypt(ecdhKey, recipient.publicKeyHex, envelope);
  assert.deepEqual(decrypted, plaintext);
});

test("ECIES ciphertext is undecryptable by a different key", async () => {
  const recipient = await generateKeyPair();
  const attacker = await generateKeyPair();
  const attackerEcdh = await importPrivateKeyForEcdh((await exportKeyPair(attacker)).privateJwk);

  const envelope = await eciesEncrypt(recipient.publicKeyHex, utf8Encode("secret"));
  await assert.rejects(() => eciesDecrypt(attackerEcdh, attacker.publicKeyHex, envelope));
});

test("SIGNAL payload is encrypted end-to-end and decrypts only for the target", async () => {
  const { node, networkId } = await makeMember();
  const target = await generateKeyPair();
  const targetStored = await exportKeyPair(target);
  const targetEcdh = await importPrivateKeyForEcdh(targetStored.privateJwk);
  const targetId = await nodeIdFromPubkey(target.publicKeyHex);

  const signal = (await createSignal(networkId, node, targetId, target.publicKeyHex, "sess", 3, {
    kind: "offer",
    sdp: "v=0 SECRET-SDP",
  })) as SignalEvent;

  // relay-visible body must not contain the SDP
  assert.ok(!JSON.stringify(signal.body).includes("SECRET-SDP"));

  const payload = await decryptSignal(targetEcdh, target.publicKeyHex, signal.body.enc);
  assert.ok(payload && payload.kind === "offer");
  assert.match((payload as { sdp: string }).sdp, /SECRET-SDP/);

  // a non-target key cannot decrypt
  const other = await generateKeyPair();
  const otherEcdh = await importPrivateKeyForEcdh((await exportKeyPair(other)).privateJwk);
  assert.equal(await decryptSignal(otherEcdh, other.publicKeyHex, signal.body.enc), null);
});

// ---------------------------------------------------------------------------
// Proof of work
// ---------------------------------------------------------------------------

test("leadingZeroBits counts correctly", () => {
  assert.equal(leadingZeroBits("ff"), 0);
  assert.equal(leadingZeroBits("7f"), 1);
  assert.equal(leadingZeroBits("0f"), 4);
  assert.equal(leadingZeroBits("00f"), 8);
  assert.equal(leadingZeroBits("001"), 11);
  assert.ok(hasPow("000abc", 12));
  assert.ok(!hasPow("00fabc", 12));
});

test("JOIN events carry valid proof-of-work and verify at the required difficulty", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain, "alice");
  assert.ok(hasPow(join.id, POW_BITS), `id ${join.id} lacks ${POW_BITS} bits`);
  assert.equal((await verifyEvent(join, { powBits: POW_BITS })).ok, true);
});

test("JOIN without enough proof-of-work is rejected", async () => {
  const { node, networkId, chain } = await makeMember();
  // mine at 0 bits, verify at the default: overwhelmingly likely to fail PoW
  let rejected = false;
  for (let i = 0; i < 3 && !rejected; i++) {
    const weak = await createJoin(networkId, node, chain, undefined, 0);
    const result = await verifyEvent(weak, { powBits: 20 });
    rejected = !result.ok && /proof-of-work/.test(result.reason ?? "");
  }
  assert.ok(rejected);
});

// ---------------------------------------------------------------------------
// Signed CRDT entries / cells
// ---------------------------------------------------------------------------

test("signed log entries verify; forged origin or content is rejected", async () => {
  const author = await generateKeyPair();
  const origin = await nodeIdFromPubkey(author.publicKeyHex);
  const log = new GSetLog(origin);
  const entry = log.append("chat", { text: "hello" }, 100);
  await signLogEntry(author.privateKey, author.publicKeyHex, entry);
  assert.equal(await verifyLogEntry(entry), true);

  // tampered text
  assert.equal(await verifyLogEntry({ ...entry, data: { text: "evil" } }), false);
  // forged origin (entry re-attributed to another node)
  const victim = await generateKeyPair();
  const victimId = await nodeIdFromPubkey(victim.publicKeyHex);
  assert.equal(
    await verifyLogEntry({ ...entry, origin: victimId, id: `${victimId}:${entry.seq}` }),
    false,
  );
  // unsigned
  const bare = log.append("chat", { text: "unsigned" }, 101);
  assert.equal(await verifyLogEntry(bare), false);
});

test("epoch-suffixed origins: same identity, two sessions, no id collision", async () => {
  const author = await generateKeyPair();
  const nodeId = await nodeIdFromPubkey(author.publicKeyHex);

  // session 1 writes two entries, session 2 (restored identity, fresh epoch)
  // writes one — historically these would collide on `${nodeId}:1`
  const s1 = new GSetLog(`${nodeId}.aaaa`);
  const e1 = s1.append("chat", { text: "one" }, 1);
  const e2 = s1.append("chat", { text: "two" }, 2);
  const s2 = new GSetLog(`${nodeId}.bbbb`);
  const e3 = s2.append("chat", { text: "three" }, 3);
  for (const e of [e1, e2, e3]) await signLogEntry(author.privateKey, author.publicKeyHex, e);

  // all three verify and bind to the same node id
  for (const e of [e1, e2, e3]) assert.equal(await verifyLogEntry(e), true);

  // a third replica merges everything without loss
  const observer = new GSetLog("observer");
  observer.merge([e1, e2, e3]);
  assert.equal(observer.size(), 3);
});

test("signed profile cells enforce namespace ownership", async () => {
  const writer = await generateKeyPair();
  const replica = await nodeIdFromPubkey(writer.publicKeyHex);
  const map = new LwwMap(replica);

  const ownKey = `nickname/${replica}`;
  const cell = map.set(ownKey, "alice");
  await signCell(writer.privateKey, writer.publicKeyHex, ownKey, cell);
  assert.equal(await verifyCell(ownKey, cell), true);

  // same signed cell presented under someone else's key must fail
  const other = await generateKeyPair();
  const otherId = await nodeIdFromPubkey(other.publicKeyHex);
  assert.equal(await verifyCell(`nickname/${otherId}`, cell), false);

  // writing outside own namespace fails even if self-signed
  const foreignKey = `nickname/${otherId}`;
  const evil = map.set(foreignKey, "impostor");
  await signCell(writer.privateKey, writer.publicKeyHex, foreignKey, evil);
  assert.equal(await verifyCell(foreignKey, evil), false);
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

test("a revocation by the issuer invalidates the chain; by a stranger it does not", async () => {
  const { genesis, node, networkId, cert, chain } = await makeMember();

  const byIssuer: RevocationMap = new Map([[cert.invite_id, new Set([genesis.publicKeyHex])]]);
  const byStranger: RevocationMap = new Map([
    [cert.invite_id, new Set([(await generateKeyPair()).publicKeyHex])],
  ]);

  assert.equal((await verifyInviteChain(networkId, chain, node.publicKeyHex)).ok, true);
  assert.equal(
    (await verifyInviteChain(networkId, chain, node.publicKeyHex, undefined, byIssuer)).ok,
    false,
  );
  assert.equal(
    (await verifyInviteChain(networkId, chain, node.publicKeyHex, undefined, byStranger)).ok,
    true,
  );
});

test("revoking a mid-chain link severs everything below it", async () => {
  const genesis = await generateKeyPair();
  const alice = await generateKeyPair();
  const bob = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const aliceCert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: alice.publicKeyHex,
    rights: ["join", "invite"],
  });
  const bobCert = await issueCertificate({
    networkId,
    issuer: alice,
    subjectPubkey: bob.publicKeyHex,
    rights: ["join"],
  });
  const chain = [aliceCert, bobCert];
  assert.equal((await verifyInviteChain(networkId, chain, bob.publicKeyHex)).ok, true);

  const revokeAlice: RevocationMap = new Map([[aliceCert.invite_id, new Set([genesis.publicKeyHex])]]);
  assert.equal(
    (await verifyInviteChain(networkId, chain, bob.publicKeyHex, undefined, revokeAlice)).ok,
    false,
  );
});

test("a downstream chain is severed the instant a mid-chain revocation is known", async () => {
  // models the mesh case: A revokes B; a node holding C's chain (rooted at
  // genesis, delegated through B) must reject C once it learns the revocation,
  // even without expiry and even though every signature is individually valid.
  const genesis = await generateKeyPair();
  const b = await generateKeyPair();
  const c = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const bCert = await issueCertificate({
    networkId,
    issuer: genesis,
    subjectPubkey: b.publicKeyHex,
    rights: ["join", "invite", "chat"],
  });
  const cCert = await issueCertificate({
    networkId,
    issuer: b,
    subjectPubkey: c.publicKeyHex,
    rights: ["join", "chat"],
  });
  const chain = [bCert, cCert];
  // before revocation: valid, even under the history-relaxed check
  assert.equal((await verifyInviteChain(networkId, chain, c.publicKeyHex)).ok, true);
  assert.equal(
    (await verifyInviteChain(networkId, chain, c.publicKeyHex, undefined, undefined, true)).ok,
    true,
  );
  // after genesis revokes B's cert: C is severed in both live and history modes
  const rev: RevocationMap = new Map([[bCert.invite_id, new Set([genesis.publicKeyHex])]]);
  assert.equal((await verifyInviteChain(networkId, chain, c.publicKeyHex, undefined, rev)).ok, false);
  assert.equal(
    (await verifyInviteChain(networkId, chain, c.publicKeyHex, undefined, rev, true)).ok,
    false,
  );
});

test("revocation map is extracted from name-service records", async () => {
  const { genesis, networkId, cert } = await makeMember();
  const store = new NameServiceStore(networkId);
  const record = await createNameRecord(
    networkId,
    genesis,
    `${REVOKED_PREFIX}${cert.invite_id}`,
    { kind: "revocation", invite_id: cert.invite_id },
    1,
    3600,
  );
  assert.equal(await store.merge(record), true);
  const map = store.revocations();
  assert.ok(map.get(cert.invite_id)?.has(genesis.publicKeyHex));

  // record with a mismatched name/invite_id is ignored
  const bogus = await createNameRecord(
    networkId,
    genesis,
    `${REVOKED_PREFIX}other-id`,
    { kind: "revocation", invite_id: cert.invite_id },
    1,
    3600,
  );
  await store.merge(bogus);
  assert.equal(store.revocations().size, 1);
});
