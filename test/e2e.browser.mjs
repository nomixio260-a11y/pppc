/**
 * E2E: two browser contexts form an ANP network over the local relay.
 *  A creates the network, B requests to join, A issues an invite bundle,
 *  B joins, both connect over WebRTC, a chat message syncs A -> B,
 *  a name-service record syncs B -> A.
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:8791";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream"],
});

function trace(name, page) {
  page.on("console", (m) => console.log(`[${name}:console]`, m.text()));
  page.on("pageerror", (e) => console.log(`[${name}:pageerror]`, e.message));
}

try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  trace("A", a);
  trace("B", b);

  await a.goto(BASE);
  await b.goto(BASE);

  // A: create network
  await a.fill("#create-nickname", "alice");
  await a.click("#btn-create");
  await a.waitForSelector("#main:not([hidden])", { timeout: 15000 });
  const netUrl = await a.textContent("#net-url");
  console.log("network:", netUrl);

  // B: join request code
  await b.click("#btn-request");
  await b.waitForSelector("#request-code:not([hidden])");
  const requestCode = await b.inputValue("#request-code");
  console.log("request code len:", requestCode.length);

  // A: issue invite
  await a.fill("#invite-pubkey", requestCode);
  await a.click("#btn-issue");
  await a.waitForSelector("#invite-bundle:not([hidden])");
  const bundle = await a.inputValue("#invite-bundle");
  console.log("bundle len:", bundle.length);

  // B: accept invite
  await b.fill("#join-nickname", "bob");
  await b.fill("#join-bundle", bundle);
  await b.click("#btn-join");
  await b.waitForSelector("#main:not([hidden])", { timeout: 15000 });
  const netUrlB = await b.textContent("#net-url");
  if (netUrlB !== netUrl) throw new Error(`network mismatch: ${netUrlB} != ${netUrl}`);

  // wait for P2P connection on both sides
  for (const [name, page] of [["A", a], ["B", b]]) {
    await page.waitForFunction(() => document.getElementById("peer-count").textContent === "1", null, {
      timeout: 30000,
    });
    console.log(`${name}: peer connected`);
  }

  // A -> B chat
  await a.fill("#chat-input", "hello from alice");
  await a.click("#btn-send");
  await b.waitForFunction(
    () => document.getElementById("chat-box").textContent.includes("hello from alice"),
    null,
    { timeout: 15000 },
  );
  console.log("chat A->B synced");

  // B -> A chat
  await b.fill("#chat-input", "hi alice, bob here");
  await b.click("#btn-send");
  await a.waitForFunction(
    () => document.getElementById("chat-box").textContent.includes("hi alice, bob here"),
    null,
    { timeout: 15000 },
  );
  console.log("chat B->A synced");

  // B publishes a name-service record, A should replicate it
  await b.fill("#ns-name", "service/demo");
  await b.fill("#ns-value", '{"kind":"node-set","nodes":["bob"]}');
  await b.click("#btn-ns-publish");
  await a.waitForFunction(
    () => document.getElementById("ns-body").textContent.includes("service/demo"),
    null,
    { timeout: 15000 },
  );
  console.log("name service B->A replicated");

  // nickname resolution via profile CRDT
  await a.waitForFunction(
    () => document.getElementById("peer-list").textContent.includes("bob"),
    null,
    { timeout: 15000 },
  );
  console.log("profile CRDT (nickname) synced");

  // reload B: identity persists in IndexedDB and it rejoins
  await b.reload();
  await b.waitForSelector("#main:not([hidden])", { timeout: 15000 });
  await b.waitForFunction(() => document.getElementById("peer-count").textContent === "1", null, {
    timeout: 30000,
  });
  console.log("B reload: identity persisted, mesh re-formed");

  console.log("E2E PASS");
} finally {
  await browser.close();
}
