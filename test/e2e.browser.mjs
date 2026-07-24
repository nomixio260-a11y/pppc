/**
 * E2E for the default UX: relay-based open rooms with automatic discovery.
 *
 *   1. Two browsers open the app and join the SAME open room (one tap).
 *   2. They auto-discover each other via the relay and connect over WebRTC.
 *   3. Chat syncs both ways; a file transfers CID-verified.
 *   4. A third browser joins the same room via the shared link and meshes in.
 *   5. Relay is killed: the P2P mesh keeps working; then it restarts.
 *
 * Run: node test/e2e.browser.mjs   (spawns its own relay on $PORT or 8795)
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8795);
const BASE = `http://localhost:${PORT}`;
const ROOM = "e2e-room";

function spawnRelay() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/relay/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay did not start")), 15000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
}

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

// join an open room through the welcome screen
async function join(page, nick) {
  await page.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  await page.fill("#welcome-nick", nick);
  await page.fill("#welcome-room", ROOM);
  await page.click("#btn-welcome-join");
  await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
}

let relay = await spawnRelay();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

try {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const c = await (await browser.newContext()).newPage();
  trace("A", a);
  trace("B", b);
  trace("C", c);

  await a.goto(BASE);
  await b.goto(BASE);

  // --- one-tap auto-join into the same open room ---
  await join(a, "alice");
  await join(b, "bob");
  console.log("A and B joined open room via one tap");

  // --- automatic discovery + P2P connect (no invites, no manual steps) ---
  await waitPeer(a, 1);
  await waitPeer(b, 1);
  console.log("A<->B auto-discovered and connected over WebRTC");

  // --- chat both ways ---
  await a.fill("#chat-input", "hello from alice");
  await a.click("#btn-send");
  await waitChat(b, "hello from alice");
  await b.fill("#chat-input", "hi alice, bob here");
  await b.click("#btn-send");
  await waitChat(a, "hi alice, bob here");
  console.log("chat synced both ways (signed CRDT)");

  // --- file transfer, CID-verified ---
  const payload = Buffer.from("ANP open-room file test ".repeat(4000)); // ~96KB
  await a.setInputFiles("#file-input", { name: "hello.txt", mimeType: "text/plain", buffer: payload });
  await waitChat(b, "hello.txt");
  await b.click(".file-dl");
  await b.waitForFunction(
    () => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("CID検証済み")),
    null,
    { timeout: 30000 },
  );
  console.log("file A->B transferred and CID-verified");

  // --- C joins the same room via the shared link ---
  await c.goto(`${BASE}/#room=${ROOM}`);
  await c.waitForSelector("#welcome:not([hidden])", { timeout: 20000 });
  // room is prefilled from the URL; just set a nick and tap join
  await c.fill("#welcome-nick", "carol");
  await c.click("#btn-welcome-join");
  await c.waitForSelector("#app:not([hidden])", { timeout: 20000 });
  await waitPeer(a, 2);
  await waitPeer(c, 2);
  console.log("C joined via shared link; full mesh of 3");

  await c.fill("#chat-input", "carol via link");
  await c.click("#btn-send");
  await waitChat(a, "carol via link");
  await waitChat(c, "hello from alice"); // pre-join history via version-vector sync
  console.log("chat C->A synced; C received pre-join history");

  // --- relay outage: the mesh survives ---
  relay.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 3000));
  await a.fill("#chat-input", "surviving without relay");
  await a.click("#btn-send");
  await waitChat(c, "surviving without relay");
  await waitPeer(a, 2, 5000);
  console.log("mesh survived relay outage (P2P chat still flowing)");

  relay = await spawnRelay();
  await a.waitForFunction(
    () => document.getElementById("conn-text")?.textContent.includes("接続中"),
    null,
    { timeout: 30000 },
  );
  console.log("relay restarted; clients reconnected");

  console.log("E2E PASS");
} finally {
  await browser.close();
  relay.kill("SIGTERM");
}
