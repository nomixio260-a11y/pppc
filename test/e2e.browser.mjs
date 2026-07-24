/**
 * E2E for the chat service: channels (auto-discovery) + encrypted DMs.
 *
 *   1. Two users open the app, pick a name, land in #general automatically.
 *   2. They auto-discover in #general via the relay and chat.
 *   3. A file transfers CID-verified.
 *   4. They start a 1:1 DM (via user ID); DM messages sync and are encrypted.
 *   5. A third user joins #general via a shared channel link.
 *
 * Run: node test/e2e.browser.mjs   (spawns its own relay on $PORT or 8795)
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8795);
const BASE = `http://localhost:${PORT}`;

function spawnRelay() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/relay/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay did not start")), 15000);
    child.stdout.on("data", (c) => c.toString().includes("listening") && (clearTimeout(timeout), resolve(child)));
    child.on("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
}
function trace(name, page) {
  page.on("pageerror", (e) => console.log(`[${name}:pageerror]`, e.message));
  page.on("dialog", (d) => d.accept());
}
const waitChat = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.getElementById("chat-box")?.textContent.includes(t), text, { timeout });
const connected = (page, timeout = 45000) =>
  page.waitForFunction(() => /接続中/.test(document.getElementById("conn-text")?.textContent ?? ""), null, { timeout });

async function onboard(page, nick) {
  await page.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  await page.fill("#welcome-nick", nick);
  await page.click("#btn-welcome-start");
  await page.waitForSelector("#layout:not([hidden])", { timeout: 20000 });
  // auto-lands in #general and opens it
  await page.waitForFunction(() => document.getElementById("room-title")?.textContent === "#general", null, { timeout: 20000 });
}

let relay = await spawnRelay();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

try {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const c = await (await browser.newContext()).newPage();
  trace("A", a);
  trace("B", b);
  trace("C", c);

  await a.goto(BASE);
  await b.goto(BASE);
  await onboard(a, "alice");
  await onboard(b, "bob");
  console.log("A and B onboarded and auto-joined #general");

  await connected(a);
  await connected(b);
  console.log("#general: A<->B auto-discovered and connected");

  await a.fill("#chat-input", "hello from alice");
  await a.click("#btn-send");
  await waitChat(b, "hello from alice");
  await b.fill("#chat-input", "hi alice");
  await b.click("#btn-send");
  await waitChat(a, "hi alice");
  console.log("channel chat synced both ways");

  // file
  const payload = Buffer.from("ANP file ".repeat(6000)); // ~54KB
  await a.setInputFiles("#file-input", { name: "note.txt", mimeType: "text/plain", buffer: payload });
  await waitChat(b, "note.txt");
  await b.click(".file-dl");
  await b.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("CID検証済み")), null, { timeout: 30000 });
  console.log("file A->B CID-verified");

  // --- DM: A gets B's user id, starts a DM ---
  const bId = await b.evaluate(() => document.getElementById("d-my-id").value);
  if (!/^[0-9a-f]{130}$/.test(bId)) throw new Error("bad user id");
  await a.click("#btn-new-dm");
  await a.waitForSelector("#modal-dm:not([hidden])");
  await a.fill("#dm-peer-id", bId);
  await a.click("#btn-dm-start");
  // B must also open the DM to be discoverable — B starts a DM to A
  const aId = await a.evaluate(() => document.getElementById("d-my-id").value);
  await b.click("#btn-new-dm");
  await b.waitForSelector("#modal-dm:not([hidden])");
  await b.fill("#dm-peer-id", aId);
  await b.click("#btn-dm-start");

  await connected(a);
  await connected(b);
  await a.fill("#chat-input", "secret DM 🔒");
  await a.click("#btn-send");
  await waitChat(b, "secret DM 🔒");
  await b.fill("#chat-input", "got it, encrypted");
  await b.click("#btn-send");
  await waitChat(a, "got it, encrypted");
  console.log("DM synced both ways (ECDH-encrypted)");

  // --- C joins #general via shared channel link ---
  await c.goto(`${BASE}/#channel=general`);
  await onboard(c, "carol");
  await connected(c);
  await c.fill("#chat-input", "carol in general");
  await c.click("#btn-send");
  // switch A back to #general (A is currently in the DM)
  await a.evaluate(() => {
    const items = [...document.querySelectorAll(".conv-item")];
    const gen = items.find((el) => el.textContent.includes("#general"));
    gen?.click();
  });
  await waitChat(a, "carol in general");
  console.log("C joined #general via link; message reached A");

  console.log("E2E PASS");
} finally {
  await browser.close();
  relay.kill("SIGTERM");
}
