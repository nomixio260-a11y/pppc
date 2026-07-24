/**
 * Offline E2E: proves the "download a file, open it, use it" path.
 *
 * Loads the SELF-CONTAINED public/anp.html via a file:// URL in two isolated
 * browser contexts — no relay, no server — and completes the manual
 * copy-paste connection, then verifies chat syncs both ways over the direct
 * WebRTC DataChannel.
 *
 * Run: npm run build && node test/e2e.offline.mjs
 */
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const FILE_URL = pathToFileURL(resolve("public/anp.html")).href;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

function trace(name, page) {
  page.on("pageerror", (e) => console.log(`[${name}:pageerror]`, e.message));
  page.on("dialog", (d) => d.accept());
}

const waitPeer = (page, n, timeout = 45000) =>
  page.waitForFunction((want) => document.getElementById("peer-count")?.textContent === String(want), n, {
    timeout,
  });
const waitChat = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.getElementById("chat-box")?.textContent.includes(t), text, { timeout });

try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  trace("A", a);
  trace("B", b);

  await a.goto(FILE_URL);
  await b.goto(FILE_URL);
  console.log("opened self-contained anp.html via file:// in two contexts");

  // A creates a network (offline; no relay)
  await a.fill("#create-nickname", "alice");
  await a.click("#btn-create");
  await a.waitForSelector("#main:not([hidden])", { timeout: 20000 });
  console.log("A created an offline network:", await a.textContent("#net-url"));

  // B: create a join request code (still on the setup screen)
  await b.click("#btn-off-request");
  await b.waitForSelector("#off-request-out:not([hidden])");
  const requestB = await b.inputValue("#off-request-out");
  if (!requestB) throw new Error("no request code");

  // A: paste B's code, create an OFFER blob
  await a.fill("#off-subject", requestB);
  await a.check("#off-grant");
  await a.click("#btn-off-offer");
  await a.waitForSelector("#off-offer-out:not([hidden])");
  const offer = await a.inputValue("#off-offer-out");
  if (!offer) throw new Error("no offer blob");
  console.log("A produced an offer blob (", offer.length, "chars)");

  // B: paste the offer, join in place, produce an ANSWER blob
  await b.fill("#off-nickname", "bob");
  await b.fill("#off-offer-in", offer);
  await b.click("#btn-off-answer");
  await b.waitForSelector("#off-answer-out:not([hidden])", { timeout: 20000 });
  const answer = await b.inputValue("#off-answer-out");
  if (!answer) throw new Error("no answer blob");
  console.log("B joined and produced an answer blob (", answer.length, "chars)");

  // A: paste the answer, complete the connection
  await a.fill("#off-answer-in", answer);
  await a.click("#btn-off-complete");

  // both sides should now be P2P connected with no relay at all
  await waitPeer(a, 1);
  await waitPeer(b, 1);
  console.log("A<->B connected directly (no relay, no server)");

  // B's view should have switched to main once connected
  await b.waitForSelector("#main:not([hidden])", { timeout: 20000 });

  // chat both ways over the direct DataChannel
  await a.fill("#chat-input", "offline hello from alice");
  await a.click("#btn-send");
  await waitChat(b, "offline hello from alice");
  await b.fill("#chat-input", "hi alice — bob, no server");
  await b.click("#btn-send");
  await waitChat(a, "hi alice — bob, no server");
  console.log("chat synced both ways over the offline DataChannel");

  console.log("OFFLINE E2E PASS");
} finally {
  await browser.close();
}
