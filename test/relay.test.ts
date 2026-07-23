/**
 * Integration test: boots the real relay in a child process and exercises the
 * REST + WebSocket API with signed events.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPair } from "../src/shared/crypto.js";
import { issueCertificate, networkIdFromGenesisPubkey, nodeIdFromPubkey } from "../src/shared/identity.js";
import { createHeartbeat, createJoin, createSignal } from "../src/shared/events.js";
import type { AnpEvent, RelayFrame } from "../src/shared/types.js";

const PORT = 18787 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let relay: ChildProcess;

before(async () => {
  relay = spawn(process.execPath, ["--import", "tsx", "src/relay/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay did not start")), 15_000);
    relay.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    relay.on("exit", () => reject(new Error("relay exited early")));
  });
});

after(() => {
  relay.kill("SIGTERM");
});

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

async function postEvent(event: AnpEvent): Promise<{ status: number; body: { accepted: boolean } }> {
  const res = await fetch(`${BASE}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: (await res.json()) as { accepted: boolean } };
}

test("relay accepts a valid signed JOIN and serves it back", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain, "alice");

  const posted = await postEvent(join);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.accepted, true);

  const res = await fetch(`${BASE}/events?network_id=${networkId}&type=JOIN`);
  const { events } = (await res.json()) as { events: AnpEvent[] };
  assert.equal(events.length, 1);
  assert.equal(events[0]!.id, join.id);
});

test("relay rejects unsigned / forged events", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain);
  const forged = { ...join, body: { ...join.body, nickname: "mallory" } } as AnpEvent;
  const posted = await postEvent(forged);
  assert.equal(posted.status, 400);
  assert.equal(posted.body.accepted, false);
});

test("relay rejects JOIN without a valid invite chain", async () => {
  const genesis = await generateKeyPair();
  const stranger = await generateKeyPair();
  const networkId = await networkIdFromGenesisPubkey(genesis.publicKeyHex);
  const join = await createJoin(networkId, stranger, []);
  const posted = await postEvent(join);
  assert.equal(posted.body.accepted, false);
});

test("a newer HEARTBEAT supersedes the older one per node", async () => {
  const { node, networkId, chain } = await makeMember();
  await postEvent(await createJoin(networkId, node, chain));
  await postEvent(await createHeartbeat(networkId, node));
  await postEvent(await createHeartbeat(networkId, node));
  const res = await fetch(`${BASE}/events?network_id=${networkId}&type=HEARTBEAT`);
  const { events } = (await res.json()) as { events: AnpEvent[] };
  assert.equal(events.length, 1);
});

test("websocket REQ returns stored events, EOSE, then live pushes", async () => {
  const { node, networkId, chain } = await makeMember();
  const join1 = await createJoin(networkId, node, chain, "alice");
  await postEvent(join1);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const frames: RelayFrame[] = [];
  const gotEose = new Promise<void>((resolve) => {
    ws.onmessage = (msg) => {
      const frame = JSON.parse(String(msg.data)) as RelayFrame;
      frames.push(frame);
      if (frame.frame === "EOSE") resolve();
    };
  });
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  ws.send(JSON.stringify({ frame: "REQ", sub_id: "s1", filter: { network_id: networkId } }));
  await gotEose;

  const stored = frames.filter((f) => f.frame === "EVENT");
  assert.equal(stored.length, 1);

  // live push after EOSE
  const livePromise = new Promise<AnpEvent>((resolve) => {
    ws.onmessage = (msg) => {
      const frame = JSON.parse(String(msg.data)) as RelayFrame;
      if (frame.frame === "EVENT") resolve(frame.event);
    };
  });
  const hb = await createHeartbeat(networkId, node);
  await postEvent(hb);
  const live = await livePromise;
  assert.equal(live.id, hb.id);
  ws.close();
});

test("SIGNAL events are only delivered to their target", async () => {
  const { node, networkId, chain } = await makeMember();
  await postEvent(await createJoin(networkId, node, chain));
  const targetId = "ab".repeat(32);
  const signal = await createSignal(networkId, node, {
    target: targetId,
    session: "s1",
    payload: { kind: "offer", sdp: "v=0" },
  });
  await postEvent(signal);

  const noTarget = await fetch(`${BASE}/events?network_id=${networkId}&type=SIGNAL`);
  assert.equal(((await noTarget.json()) as { events: AnpEvent[] }).events.length, 0);

  const wrongTarget = await fetch(
    `${BASE}/events?network_id=${networkId}&type=SIGNAL&target=${"cd".repeat(32)}`,
  );
  assert.equal(((await wrongTarget.json()) as { events: AnpEvent[] }).events.length, 0);

  const rightTarget = await fetch(`${BASE}/events?network_id=${networkId}&type=SIGNAL&target=${targetId}`);
  const { events } = (await rightTarget.json()) as { events: AnpEvent[] };
  assert.equal(events.length, 1);
  assert.equal(events[0]!.id, signal.id);
});

test("node_id matches sha256 of pubkey in served events", async () => {
  const { node, networkId, chain } = await makeMember();
  const join = await createJoin(networkId, node, chain);
  await postEvent(join);
  assert.equal(join.node_id, await nodeIdFromPubkey(node.publicKeyHex));
});
