/**
 * E2E: three browser contexts form an ANP network over a local relay.
 *
 *   1. A creates the network (genesis) and invites B (with invite rights).
 *   2. B joins via bundle paste; A<->B connect over WebRTC; chat syncs both ways.
 *   3. A shares a file; B fetches it over the DataChannel (CID-verified).
 *   4. B invites C via an invite LINK (delegated two-link chain).
 *   5. C connects to both; chat from C reaches A.
 *   6. The relay is killed: the P2P mesh must survive; then it restarts and
 *      clients reconnect.
 *   7. A revokes B's invite: B and C (chained through B) are ejected.
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

const waitPeerCount = (page, n, timeout = 45000) =>
  page.waitForFunction((want) => document.getElementById("peer-count").textContent === String(want), n, {
    timeout,
  });

const waitChatContains = (page, text, timeout = 20000) =>
  page.waitForFunction(
    (t) => document.getElementById("chat-box").textContent.includes(t),
    text,
    { timeout },
  );

let relay = await spawnRelay();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const c = await ctxC.newPage();
  trace("A", a);
  trace("B", b);
  trace("C", c);

  await a.goto(BASE);
  await b.goto(BASE);
  await c.goto(BASE);

  // --- A creates the network -------------------------------------------------
  await a.fill("#create-nickname", "alice");
  await a.click("#btn-create");
  await a.waitForSelector("#main:not([hidden])", { timeout: 20000 });
  const netUrl = await a.textContent("#net-url");
  console.log("network:", netUrl);

  // --- B requests + A invites (with invite rights) ---------------------------
  await b.click("#btn-request");
  await b.waitForSelector("#request-code:not([hidden])");
  const requestB = await b.inputValue("#request-code");

  await a.fill("#invite-pubkey", requestB);
  await a.check("#invite-grant");
  await a.click("#btn-issue");
  await a.waitForSelector("#invite-bundle:not([hidden])");
  const bundleB = await a.inputValue("#invite-bundle");

  await b.fill("#join-nickname", "bob");
  await b.fill("#join-bundle", bundleB);
  await b.click("#btn-join");
  await b.waitForSelector("#main:not([hidden])", { timeout: 20000 });
  if ((await b.textContent("#net-url")) !== netUrl) throw new Error("network mismatch");

  await waitPeerCount(a, 1);
  await waitPeerCount(b, 1);
  console.log("A<->B connected");

  // --- chat both ways --------------------------------------------------------
  await a.fill("#chat-input", "hello from alice");
  await a.click("#btn-send");
  await waitChatContains(b, "hello from alice");
  await b.fill("#chat-input", "hi alice, bob here");
  await b.click("#btn-send");
  await waitChatContains(a, "hi alice, bob here");
  console.log("chat A<->B synced (signed entries)");

  // members verified badge
  await a.waitForFunction(() => document.getElementById("peer-list").textContent.includes("検証済み"));

  // --- file sharing ----------------------------------------------------------
  const payload = Buffer.from("ANP file transfer test ".repeat(4000)); // ~92KB, multi-chunk
  await a.setInputFiles("#file-input", {
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: payload,
  });
  await waitChatContains(b, "hello.txt");
  await b.click(".file-dl");
  await b.waitForFunction(
    () => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("CID検証済み")),
    null,
    { timeout: 30000 },
  );
  console.log("file A->B transferred and CID-verified");

  // --- C joins via invite link (delegated chain through B) -------------------
  await c.click("#btn-request");
  await c.waitForSelector("#request-code:not([hidden])");
  const requestC = await c.inputValue("#request-code");

  await b.fill("#invite-pubkey", requestC);
  await b.click("#btn-issue");
  await b.waitForSelector("#invite-link-row:not([hidden])");
  const inviteLink = await b.inputValue("#invite-link");
  if (!inviteLink.includes("#invite=")) throw new Error("invite link missing");

  await c.goto(inviteLink);
  await c.waitForFunction(() => document.getElementById("join-bundle").value.length > 0);
  await c.fill("#join-nickname", "carol");
  await c.click("#btn-join");
  await c.waitForSelector("#main:not([hidden])", { timeout: 20000 });

  await waitPeerCount(a, 2);
  await waitPeerCount(b, 2);
  await waitPeerCount(c, 2);
  console.log("C joined via invite link; full mesh of 3");

  await c.fill("#chat-input", "carol was here");
  await c.click("#btn-send");
  await waitChatContains(a, "carol was here");
  // C must also see history from before it joined (VV sync)
  await waitChatContains(c, "hello from alice");
  console.log("chat C->A synced; C received pre-join history");

  // --- relay outage: the mesh must survive -----------------------------------
  relay.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 3000));
  await a.fill("#chat-input", "surviving without relay");
  await a.click("#btn-send");
  await waitChatContains(c, "surviving without relay");
  await waitPeerCount(a, 2, 5000);
  console.log("mesh survived relay outage (P2P chat still flowing)");

  relay = await spawnRelay();
  // wait for ALL nodes to reconnect so revocation has a live propagation path
  const reconnected = (page) =>
    page.waitForFunction(
      () => {
        const el = document.getElementById("relay-list");
        return el && /受信 [1-9]/.test(el.textContent);
      },
      null,
      { timeout: 45000 },
    );
  await Promise.all([reconnected(a), reconnected(b), reconnected(c)]);
  console.log("relay restarted; all clients reconnected");

  // --- revocation: eject B (and C, whose chain runs through B) ---------------
  // Revocation delivery to the *revoked* node is best-effort; the security
  // guarantee is that every honest node ejects the revoked member. Assert on
  // that stable outcome: A ejects both B and C; C (chained through B) loses
  // both peers. B's self-notification toast is a courtesy, not asserted here.
  await a.click(".revoke-btn");
  await waitPeerCount(a, 0, 45000);
  await waitPeerCount(c, 0, 45000);
  console.log("revocation ejected B and C (honest nodes enforce revocation)");

  console.log("E2E PASS");
} finally {
  await browser.close();
  relay.kill("SIGTERM");
}
