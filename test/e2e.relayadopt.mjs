/**
 * Relay failover over the mesh (discovery spec §12.1).
 *
 * The scenario the peer-table relay hints exist for:
 *
 *   1. Alice knows relay A and relay B. Bob knows ONLY relay A.
 *   2. They meet on relay A and open a WebRTC link.
 *   3. Relay A is killed. Bob now has ZERO working relays — without hints he is
 *      cut off from all future discovery even though his link to Alice is fine.
 *   4. Bob learns relay B from Alice's peer table, adopts it, and is visible on
 *      relay B again: a brand-new node that only knows relay B finds him.
 *
 * Run: node test/e2e.relayadopt.mjs
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const PORT_A = Number(process.env.PORT ?? 8861); // also serves the frontend
const PORT_B = PORT_A + 40;
const RELAY_A = `ws://localhost:${PORT_A}`;
const RELAY_B = `ws://localhost:${PORT_B}`;

function spawnRelay(port) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/relay/server.ts"], {
    env: { ...process.env, PORT: String(port), ANP_HTTPS: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`relay ${port} did not start`)), 15000);
    child.stdout.on("data", (c) => c.toString().includes("listening") && (clearTimeout(timeout), resolve(child)));
    child.on("exit", (code) => reject(new Error(`relay ${port} exited early (${code})`)));
  });
}

const connected = (page, timeout = 45000) =>
  page.waitForFunction(() => /接続中/.test(document.getElementById("conn-text")?.textContent ?? ""), null, { timeout });
const waitChat = (page, text, timeout = 25000) =>
  page.waitForFunction((t) => document.getElementById("chat-box")?.textContent.includes(t), text, { timeout });

async function onboard(page, nick) {
  await page.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  await page.fill("#welcome-nick", nick);
  await page.click("#btn-welcome-start");
  await page.waitForFunction(() => document.getElementById("room-title")?.textContent === "#general", null, {
    timeout: 20000,
  });
}

/** the relay URLs currently listed in the settings drawer */
const relayList = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#relay-list li span")].map((s) => s.textContent.trim()),
  );

let relayA = await spawnRelay(PORT_A);
const relayB = await spawnRelay(PORT_B);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

try {
  // Alice starts with BOTH relays (via the #relay= hint plus a manual add);
  // Bob starts with relay A only.
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  for (const [n, p] of [["alice", alice], ["bob", bob]])
    p.on("pageerror", (e) => console.log(`[${n}:pageerror]`, e.message));

  await alice.goto(`http://localhost:${PORT_A}/#relay=${RELAY_A}`);
  await bob.goto(`http://localhost:${PORT_A}/#relay=${RELAY_A}`);
  await onboard(alice, "alice");
  await onboard(bob, "bob");

  await alice.click("#btn-settings");
  await alice.waitForSelector("#relay-sec");
  await alice.evaluate(() => document.getElementById("relay-sec").setAttribute("open", ""));
  await alice.fill("#relay-add-url", RELAY_B);
  await alice.click("#btn-relay-add");
  await alice.click("#btn-drawer-close");

  const bobRelaysBefore = await bob.evaluate(() =>
    [...document.querySelectorAll("#relay-list li span")].map((s) => s.textContent.trim()),
  );
  if (bobRelaysBefore.some((u) => u.includes(String(PORT_B))))
    throw new Error("bob was not supposed to know relay B yet");
  console.log(`alice: A+B, bob: A only (${bobRelaysBefore.join(", ")})`);

  await connected(alice);
  await connected(bob);
  await alice.fill("#chat-input", "linked over relay A");
  await alice.click("#btn-send");
  await waitChat(bob, "linked over relay A");
  console.log("alice <-> bob linked over relay A");

  // --- relay A dies: bob has zero relays, only the mesh ---
  relayA.kill("SIGKILL");
  relayA = undefined;
  console.log("relay A killed — bob is now relay-isolated");

  const adopted = await bob
    .waitForFunction(
      (port) =>
        [...document.querySelectorAll("#relay-list li span")].some((s) => s.textContent.includes(port)),
      String(PORT_B),
      { timeout: 45000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!adopted) {
    throw new Error(`bob never adopted relay B from the mesh — relays: ${(await relayList(bob)).join(", ")}`);
  }
  console.log(`bob adopted relay B from alice's peer table: ${(await relayList(bob)).join(", ")}`);

  // --- and the adoption is real: a fresh node that only knows relay B finds bob ---
  const carol = await (await browser.newContext()).newPage();
  carol.on("pageerror", (e) => console.log("[carol:pageerror]", e.message));
  await carol.goto(`http://localhost:${PORT_B}/#relay=${RELAY_B}`);
  await onboard(carol, "carol");
  await connected(carol);
  await carol.fill("#chat-input", "hello from the relay-B side");
  await carol.click("#btn-send");
  await waitChat(bob, "hello from the relay-B side", 40000);
  console.log("carol (relay B only) reached bob — adoption restored discovery");

  console.log("RELAY ADOPTION E2E PASS");
} finally {
  await browser.close();
  relayA?.kill("SIGTERM");
  relayB.kill("SIGTERM");
}
