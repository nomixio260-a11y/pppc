/**
 * Multi-relay E2E (discovery spec §7.3, §8.3 relay diversity, §12.1 failover).
 *
 *   1. Two relays are started; the frontend is pointed at BOTH.
 *   2. Two users join the same channel and connect.
 *   3. The discovery panel shows a candidate seen by 2 relays (diversity > 1),
 *      proving duplicate deliveries are attributed rather than swallowed.
 *   4. Relay #1 is killed: discovery/chat keeps working through relay #2.
 *
 * Run: node test/e2e.multirelay.mjs
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const PORT_A = Number(process.env.PORT ?? 8801); // serves the frontend too
const PORT_B = PORT_A + 40;
const BASE = `http://localhost:${PORT_A}`;

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

// onboard with BOTH relays configured (second added via the settings drawer)
async function onboard(page, nick) {
  await page.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  await page.fill("#welcome-nick", nick);
  await page.click("#btn-welcome-start");
  await page.waitForFunction(() => document.getElementById("room-title")?.textContent === "#general", null, {
    timeout: 20000,
  });
  await page.click("#btn-settings");
  await page.waitForSelector("#relay-sec");
  await page.evaluate(() => document.getElementById("relay-sec").setAttribute("open", ""));
  await page.fill("#relay-add-url", `ws://localhost:${PORT_B}`);
  await page.click("#btn-relay-add");
  await page.click("#btn-drawer-close");
}

let relayA = await spawnRelay(PORT_A);
let relayB = await spawnRelay(PORT_B);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

try {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  for (const [n, p] of [["A", a], ["B", b]]) p.on("pageerror", (e) => console.log(`[${n}:pageerror]`, e.message));

  await a.goto(BASE);
  await b.goto(BASE);
  await onboard(a, "alice");
  await onboard(b, "bob");
  console.log("both users online with 2 relays configured");

  await connected(a);
  await connected(b);
  console.log("connected over WebRTC");

  await a.fill("#chat-input", "hello over two relays");
  await a.click("#btn-send");
  await waitChat(b, "hello over two relays");
  console.log("chat works with 2 relays");

  // --- relay diversity: the same node reported by both relays (§8.3) ---
  await a.click("#btn-settings");
  await a.waitForSelector("#discovery-sec");
  await a.evaluate(() => document.getElementById("discovery-sec").setAttribute("open", ""));
  await a.waitForFunction(() => Number(document.getElementById("disc-count")?.textContent) >= 1, null, {
    timeout: 20000,
  });
  // The same peer must be attributed to BOTH relays. Before the sighting fix
  // the pool swallowed the duplicate and diversity was stuck at 1 forever.
  const diversity = await a
    .waitForFunction(() => Number(document.getElementById("disc-diversity")?.textContent) >= 2, null, {
      timeout: 30000,
    })
    .then(() => true)
    .catch(() => false);
  if (!diversity) {
    const seen = await a.evaluate(() => document.getElementById("disc-diversity")?.textContent);
    throw new Error(`relay diversity never reached 2 (max seen: ${seen}) — §8.3 term is dead`);
  }
  console.log("discovery panel reports relay diversity >= 2 (§8.3)");
  await a.click("#btn-drawer-close");

  // --- §12.1: kill relay A; relay B keeps discovery alive ---
  relayA.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 2500));
  await b.fill("#chat-input", "still here after relay A died");
  await b.click("#btn-send");
  await waitChat(a, "still here after relay A died");
  console.log("chat survives losing one relay (§12.1 failover)");

  // a fresh node can still discover through the surviving relay
  const c = await (await browser.newContext()).newPage();
  c.on("pageerror", (e) => console.log("[C:pageerror]", e.message));
  // relay A served the page and is gone, so point C at relay B via #relay=
  await c.goto(`http://localhost:${PORT_B}/#relay=ws://localhost:${PORT_B}`);
  await c.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  await c.fill("#welcome-nick", "carol");
  await c.click("#btn-welcome-start");
  await c.waitForFunction(() => document.getElementById("room-title")?.textContent === "#general", null, {
    timeout: 20000,
  });
  await connected(c);
  console.log("new node discovered peers through the surviving relay");

  console.log("MULTI-RELAY E2E PASS");
} finally {
  await browser.close();
  relayA.kill("SIGTERM");
  relayB.kill("SIGTERM");
}
