/**
 * Direct messages: a private open network for exactly two identities, with
 * ECDH shared-key encrypted bodies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDmKey,
  dmDecrypt,
  dmEncrypt,
  exportKeyPair,
  generateKeyPair,
  importPrivateKeyForEcdh,
} from "../src/shared/crypto.js";
import { dmNetworkId, dmPubkeys, dmRoom, isDmRoom } from "../src/shared/identity.js";
import { POW_BITS, createJoin, verifyEvent } from "../src/shared/events.js";

test("dm room id is symmetric and parseable", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  assert.equal(dmRoom(a.publicKeyHex, b.publicKeyHex), dmRoom(b.publicKeyHex, a.publicKeyHex));
  assert.equal(await dmNetworkId(a.publicKeyHex, b.publicKeyHex), await dmNetworkId(b.publicKeyHex, a.publicKeyHex));
  assert.ok(isDmRoom(dmRoom(a.publicKeyHex, b.publicKeyHex)));
  const pair = dmPubkeys(dmRoom(a.publicKeyHex, b.publicKeyHex));
  assert.ok(pair && pair.includes(a.publicKeyHex) && pair.includes(b.publicKeyHex));
});

test("both DM parties derive the same key; a third party cannot", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const c = await generateKeyPair();
  const aEcdh = await importPrivateKeyForEcdh((await exportKeyPair(a)).privateJwk);
  const bEcdh = await importPrivateKeyForEcdh((await exportKeyPair(b)).privateJwk);
  const cEcdh = await importPrivateKeyForEcdh((await exportKeyPair(c)).privateJwk);

  const kA = await deriveDmKey(aEcdh, b.publicKeyHex, a.publicKeyHex);
  const kB = await deriveDmKey(bEcdh, a.publicKeyHex, b.publicKeyHex);

  const env = await dmEncrypt(kA, "秘密のメッセージ");
  assert.equal(await dmDecrypt(kB, env), "秘密のメッセージ"); // B reads A's message
  assert.equal(await dmDecrypt(kA, env), "秘密のメッセージ"); // A reads own message

  // C derives a key against A but it does not match A<->B's key
  const kCA = await deriveDmKey(cEcdh, a.publicKeyHex, c.publicKeyHex);
  assert.equal(await dmDecrypt(kCA, env), null);
});

test("only the two named parties may JOIN a DM network", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const c = await generateKeyPair();
  const room = dmRoom(a.publicKeyHex, b.publicKeyHex);
  const networkId = await dmNetworkId(a.publicKeyHex, b.publicKeyHex);

  const joinA = await createJoin(networkId, a, [], { open: true, room });
  assert.equal((await verifyEvent(joinA, { powBits: POW_BITS })).ok, true);

  const joinB = await createJoin(networkId, b, [], { open: true, room });
  assert.equal((await verifyEvent(joinB, { powBits: POW_BITS })).ok, true);

  // C is not a party — its JOIN to this DM network is rejected
  const joinC = await createJoin(networkId, c, [], { open: true, room });
  const r = await verifyEvent(joinC, { powBits: POW_BITS });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not a party/);
});
