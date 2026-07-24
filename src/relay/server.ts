/**
 * ANP Relay (design doc §7), protocol v2.
 *
 * The relay is NOT the service. It only:
 *   - stores signed discovery/transport events, indexed by network_id
 *   - answers queries (REST GET /events, WebSocket REQ) and pushes live events
 *   - drops expired events (TTL sweep)
 *   - assists with signature verification (rejects invalid events)
 *
 * It deliberately does NOT: persist user data, arbitrate rules, run services,
 * or act as an admin authority. State is in-memory only — losing it is fine,
 * because the network re-announces itself (design doc §13: regeneration, not
 * restoration).
 *
 * v2 hardening:
 *   - per-connection token-bucket rate limiting (events and REQs)
 *   - per-node event caps inside each network bucket
 *   - WebSocket ping/pong liveness with dead-connection reaping
 *   - subscription caps per connection
 *   - JOIN proof-of-work enforcement (ANP_POW_BITS, default 12)
 *
 * Wire protocol (Nostr-like):
 *   client -> relay: {frame:"EVENT",event} | {frame:"REQ",sub_id,filter} | {frame:"CLOSE",sub_id}
 *   relay -> client: {frame:"EVENT",sub_id,event} | {frame:"EOSE",sub_id}
 *                  | {frame:"OK",event_id,accepted,message} | {frame:"NOTICE",message}
 *
 * Also serves the browser client from ./public for a one-command demo.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { JOIN_TTL, POW_BITS, verifyEvent } from "../shared/events.js";
import { nowSeconds } from "../shared/crypto.js";
import type { AnpEvent, ClientFrame, EventFilter, RelayFrame } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const POW_REQUIRED_BITS = Number(process.env.ANP_POW_BITS ?? POW_BITS);
/**
 * When behind a reverse proxy / tunnel (e.g. Cloudflare Tunnel), the socket
 * address is the proxy, so per-IP limits must key on the forwarded client IP.
 * Off by default (a direct-facing relay must NOT trust client-set headers).
 */
const TRUST_PROXY = process.env.ANP_TRUST_PROXY === "1";
/** Frontend directory. Defaults to <cwd>/public so it resolves the same
 * whether run via tsx (dev) or as a bundled JS file (prod), as long as the
 * process starts from the repo root. Override with ANP_PUBLIC_DIR. */
const PUBLIC_DIR = process.env.ANP_PUBLIC_DIR ?? resolve(process.cwd(), "public");

/** Client IP for rate-limiting: forwarded header when trusted, else socket. */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
    const raw = Array.isArray(fwd) ? fwd[0] : fwd;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

const MAX_EVENTS_PER_NETWORK = 5000;
/** cap for a node's stored discovery events (JOIN/HEARTBEAT/LEAVE/MANIFEST) */
const MAX_EVENTS_PER_NODE = 16;
/** separate, higher cap for SIGNAL bursts (trickle ICE during mesh bootstrap) */
const MAX_SIGNALS_PER_NODE = 256;
const MAX_NETWORKS = 1000;
const MAX_JOINS_PER_NETWORK = 2000;
const MAX_CONNECTIONS = 500;
const MAX_CONNECTIONS_PER_IP = 16;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_SUBS_PER_CONN = 8;
const RATE_CAPACITY = 60; // token bucket: burst
const RATE_REFILL_PER_SEC = 6; // sustained events/sec per connection
const PING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens = RATE_CAPACITY;
  private last = Date.now();

  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(RATE_CAPACITY, this.tokens + ((now - this.last) / 1000) * RATE_REFILL_PER_SEC);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

class EventStore {
  /** network_id -> event_id -> event */
  private networks = new Map<string, Map<string, AnpEvent>>();
  /** network_id -> node_id -> JOIN expiry: nodes that proved membership */
  private joinIndex = new Map<string, Map<string, number>>();
  /** network_id -> unix seconds of last accepted event (LRU eviction) */
  private activity = new Map<string, number>();

  /**
   * Membership gate: a node may only store non-JOIN events after a valid
   * (chain-verified, PoW-paying) JOIN — so throwaway keypairs cannot flood a
   * network's bucket and evict legitimate discovery events.
   */
  hasLiveJoin(networkId: string, nodeId: string, now = nowSeconds()): boolean {
    const expiry = this.joinIndex.get(networkId)?.get(nodeId);
    return typeof expiry === "number" && expiry > now;
  }

  add(event: AnpEvent): { added: boolean; reason?: string } {
    let bucket = this.networks.get(event.network_id);
    if (!bucket) {
      if (this.networks.size >= MAX_NETWORKS) this.evictColdestNetwork();
      bucket = new Map();
      this.networks.set(event.network_id, bucket);
    }
    this.activity.set(event.network_id, nowSeconds());
    if (event.type === "JOIN") {
      let nodes = this.joinIndex.get(event.network_id);
      if (!nodes) {
        nodes = new Map();
        this.joinIndex.set(event.network_id, nodes);
      }
      // clamp retention to the intended JOIN lifetime — never trust a node's
      // self-declared expires_at (could be up to the 24h event ceiling)
      const expiry = Math.min(event.expires_at, nowSeconds() + JOIN_TTL);
      const prev = nodes.get(event.node_id) ?? 0;
      nodes.set(event.node_id, Math.max(prev, expiry));
      // bound the index: evict the soonest-expiring node when over capacity
      if (nodes.size > MAX_JOINS_PER_NETWORK) {
        let soonest: string | undefined;
        let soonestAt = Infinity;
        for (const [nodeId, at] of nodes) {
          if (at < soonestAt) {
            soonestAt = at;
            soonest = nodeId;
          }
        }
        if (soonest && soonest !== event.node_id) nodes.delete(soonest);
      }
    }
    if (bucket.has(event.id)) return { added: false, reason: "duplicate" };

    // A node's newer JOIN/HEARTBEAT/MANIFEST/LEAVE supersedes its older one.
    let discoveryCount = 0;
    let signalCount = 0;
    for (const [id, existing] of bucket) {
      if (existing.node_id !== event.node_id) continue;
      if (existing.type === "SIGNAL") signalCount++;
      else discoveryCount++;
      if (event.type !== "SIGNAL" && existing.type === event.type) {
        bucket.delete(id);
        discoveryCount--;
      }
    }
    if (event.type === "SIGNAL" && signalCount >= MAX_SIGNALS_PER_NODE) {
      return { added: false, reason: "per-node signal cap" };
    }
    if (event.type !== "SIGNAL" && discoveryCount >= MAX_EVENTS_PER_NODE) {
      return { added: false, reason: "per-node event cap" };
    }
    if (bucket.size >= MAX_EVENTS_PER_NETWORK) this.evictOldest(bucket);

    bucket.set(event.id, event);
    return { added: true };
  }

  /** At network capacity, drop the network idle the longest (not new joiners). */
  private evictColdestNetwork(): void {
    let coldest: string | undefined;
    let coldestAt = Infinity;
    for (const [networkId] of this.networks) {
      const at = this.activity.get(networkId) ?? 0;
      if (at < coldestAt) {
        coldestAt = at;
        coldest = networkId;
      }
    }
    if (coldest) {
      this.networks.delete(coldest);
      this.joinIndex.delete(coldest);
      this.activity.delete(coldest);
    }
  }

  query(filter: EventFilter, now = nowSeconds()): AnpEvent[] {
    const bucket = this.networks.get(filter.network_id);
    if (!bucket) return [];
    const out: AnpEvent[] = [];
    for (const event of bucket.values()) {
      if (matches(event, filter, now)) out.push(event);
    }
    return out.sort((a, b) => a.created_at - b.created_at);
  }

  sweep(now = nowSeconds()): number {
    let dropped = 0;
    for (const [networkId, bucket] of this.networks) {
      for (const [id, event] of bucket) {
        if (event.expires_at <= now) {
          bucket.delete(id);
          dropped++;
        }
      }
      if (bucket.size === 0) {
        this.networks.delete(networkId);
        this.activity.delete(networkId);
      }
    }
    for (const [networkId, nodes] of this.joinIndex) {
      for (const [nodeId, expiry] of nodes) {
        if (expiry <= now) nodes.delete(nodeId);
      }
      if (nodes.size === 0) this.joinIndex.delete(networkId);
    }
    return dropped;
  }

  stats(): { networks: number; events: number } {
    let events = 0;
    for (const bucket of this.networks.values()) events += bucket.size;
    return { networks: this.networks.size, events };
  }

  /**
   * Fair eviction: drop the oldest event belonging to whichever node holds
   * the MOST events in this network. A global-oldest policy would let a few
   * chatty (or malicious) nodes push everyone else's discovery events out;
   * targeting the heaviest node gives max-min fairness across members.
   */
  private evictOldest(bucket: Map<string, AnpEvent>): void {
    const counts = new Map<string, number>();
    for (const event of bucket.values()) {
      counts.set(event.node_id, (counts.get(event.node_id) ?? 0) + 1);
    }
    let heaviest: string | undefined;
    let max = 0;
    for (const [nodeId, n] of counts) {
      if (n > max) {
        max = n;
        heaviest = nodeId;
      }
    }
    let victimId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, event] of bucket) {
      if (event.node_id !== heaviest) continue;
      if (event.created_at < oldestAt) {
        oldestAt = event.created_at;
        victimId = id;
      }
    }
    if (victimId) bucket.delete(victimId);
  }
}

function matches(event: AnpEvent, filter: EventFilter, now: number): boolean {
  if (event.expires_at <= now) return false;
  if (event.network_id !== filter.network_id) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.node_id && event.node_id !== filter.node_id) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (event.type === "SIGNAL") {
    // SIGNAL events are point-to-point: only deliver to their target.
    if (!filter.target || event.body.target !== filter.target) return false;
  }
  return true;
}

const store = new EventStore();
setInterval(() => store.sweep(), 15_000).unref();

// ---------------------------------------------------------------------------
// Ingest + fan-out
// ---------------------------------------------------------------------------

interface Subscription {
  ws: WebSocket;
  subId: string;
  filter: EventFilter;
}

const subscriptions = new Set<Subscription>();

async function ingest(event: AnpEvent): Promise<{ accepted: boolean; message?: string }> {
  const check = await verifyEvent(event, { powBits: POW_REQUIRED_BITS });
  if (!check.ok) return { accepted: false, message: check.reason };
  // membership gate: only nodes with a live chain-verified JOIN may store
  // HEARTBEAT / LEAVE / MANIFEST / SIGNAL events (anti-flooding)
  if (event.type !== "JOIN" && !store.hasLiveJoin(event.network_id, event.node_id)) {
    return { accepted: false, message: "no live JOIN for this node (send JOIN first)" };
  }
  const result = store.add(event);
  if (!result.added) {
    // duplicates are fine (idempotent publish); caps are an error
    return result.reason === "duplicate"
      ? { accepted: true }
      : { accepted: false, message: result.reason };
  }
  const now = nowSeconds();
  for (const sub of subscriptions) {
    if (sub.ws.readyState === WebSocket.OPEN && matches(event, sub.filter, now)) {
      send(sub.ws, { frame: "EVENT", sub_id: sub.subId, event });
    }
  }
  return { accepted: true };
}

function send(ws: WebSocket, frame: RelayFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* peer gone */
  }
}

// ---------------------------------------------------------------------------
// HTTP: REST API + static client
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FRAME_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** REST rate limiting per remote address. */
const restBuckets = new Map<string, TokenBucket>();
setInterval(() => restBuckets.clear(), 10 * 60_000).unref();

function restBucket(req: IncomingMessage): TokenBucket {
  const key = clientIp(req);
  let bucket = restBuckets.get(key);
  if (!bucket) {
    bucket = new TokenBucket();
    restBuckets.set(key, bucket);
  }
  return bucket;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/event") {
      if (!restBucket(req).take()) return json(res, 429, { accepted: false, message: "rate limited" });
      const event = JSON.parse(await readBody(req)) as AnpEvent;
      const result = await ingest(event);
      return json(res, result.accepted ? 200 : 400, result);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      if (!restBucket(req).take()) return json(res, 429, { error: "rate limited" });
      const networkId = url.searchParams.get("network_id");
      if (!networkId) return json(res, 400, { error: "network_id required" });
      const filter: EventFilter = { network_id: networkId };
      const types = url.searchParams.get("type");
      if (types) filter.types = types.split(",") as EventFilter["types"];
      const target = url.searchParams.get("target");
      if (target) filter.target = target;
      const since = url.searchParams.get("since");
      if (since) filter.since = Number(since);
      return json(res, 200, { events: store.query(filter) });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        pow_bits: POW_REQUIRED_BITS,
        subscriptions: subscriptions.size,
        ...store.stats(),
      });
    }
    // static client
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const path = normalize(join(PUBLIC_DIR, rel));
      const root = normalize(PUBLIC_DIR);
      if (path !== root && !path.startsWith(root + "/")) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      try {
        const data = await readFile(path);
        res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end("not found");
      }
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

interface ConnState {
  alive: boolean;
  bucket: TokenBucket;
  subs: Set<Subscription>;
  ip: string;
}

const connections = new Map<WebSocket, ConnState>();
/** active WebSocket connections per remote address */
const connsPerIp = new Map<string, number>();

function onWsConnection(ws: WebSocket, req: IncomingMessage): void {
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, "server busy");
    return;
  }
  const ip = clientIp(req);
  // per-IP cap: one source can't monopolize the global slots or multiply its
  // rate/CPU budget by opening many connections
  if ((connsPerIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, "too many connections from this address");
    return;
  }
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
  const state: ConnState = { alive: true, bucket: new TokenBucket(), subs: new Set(), ip };
  connections.set(ws, state);

  ws.on("pong", () => {
    state.alive = true;
  });

  // wrap the async handler so a crafted frame can never produce an
  // unhandled rejection that takes down the whole relay process
  ws.on("message", (raw) => {
    void handleFrame(raw.toString()).catch((err) => {
      send(ws, { frame: "NOTICE", message: `internal error: ${(err as Error).message}` });
    });
  });

  async function handleFrame(text: string): Promise<void> {
    if (!state.bucket.take()) {
      return send(ws, { frame: "NOTICE", message: "rate limited" });
    }
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return send(ws, { frame: "NOTICE", message: "invalid json" });
    }
    if (frame.frame === "EVENT") {
      const result = await ingest(frame.event);
      send(ws, {
        frame: "OK",
        event_id: typeof frame.event?.id === "string" ? frame.event.id : "",
        accepted: result.accepted,
        message: result.message,
      });
    } else if (frame.frame === "REQ") {
      if (!frame.filter?.network_id || typeof frame.sub_id !== "string") {
        return send(ws, { frame: "NOTICE", message: "REQ requires sub_id and filter.network_id" });
      }
      // replace an existing subscription with the same id
      for (const sub of state.subs) {
        if (sub.subId === frame.sub_id) {
          state.subs.delete(sub);
          subscriptions.delete(sub);
        }
      }
      if (state.subs.size >= MAX_SUBS_PER_CONN) {
        return send(ws, { frame: "NOTICE", message: "too many subscriptions" });
      }
      const sub: Subscription = { ws, subId: frame.sub_id, filter: frame.filter };
      state.subs.add(sub);
      subscriptions.add(sub);
      for (const event of store.query(frame.filter)) {
        send(ws, { frame: "EVENT", sub_id: frame.sub_id, event });
      }
      send(ws, { frame: "EOSE", sub_id: frame.sub_id });
    } else if (frame.frame === "CLOSE") {
      for (const sub of state.subs) {
        if (sub.subId === frame.sub_id) {
          state.subs.delete(sub);
          subscriptions.delete(sub);
        }
      }
    } else {
      send(ws, { frame: "NOTICE", message: "unknown frame" });
    }
  }

  ws.on("close", () => {
    for (const sub of state.subs) subscriptions.delete(sub);
    connections.delete(ws);
    const n = (connsPerIp.get(state.ip) ?? 1) - 1;
    if (n <= 0) connsPerIp.delete(state.ip);
    else connsPerIp.set(state.ip, n);
  });
  ws.on("error", () => ws.close());
}

/** Attach a WebSocket server (sharing all relay state) to an HTTP(S) server. */
function attachWs(server: HttpServer): void {
  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
  wss.on("connection", onWsConnection);
}

// liveness: ping every connection; reap ones that never pong back
setInterval(() => {
  for (const [ws, state] of connections) {
    if (!state.alive) {
      ws.terminate();
      continue;
    }
    state.alive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, PING_INTERVAL_MS).unref();

/** First non-internal IPv4 address (the LAN IP phones on the same Wi-Fi use). */
function lanIp(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

const httpServer = createServer(handleHttp);
attachWs(httpServer);

httpServer.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}/`;
  console.log(`\n  ✅ ANP Chat が起動しました → ${local}\n`);
  console.log(`[anp-relay] listening http ${HOST}:${PORT}  (PoW ${POW_REQUIRED_BITS} bits, trust-proxy ${TRUST_PROXY})`);
  if (process.env.ANP_OPEN === "1") openBrowser(local);

  // HTTPS: browsers block Web Crypto/WebRTC over plain http (except localhost),
  // so we serve the app over https for other devices. NO external service —
  // the cert is generated locally (or supply your own real cert). Off behind a
  // real proxy (hosted, which already terminates TLS) or ANP_HTTPS=0.
  if (process.env.ANP_HTTPS === "0" || TRUST_PROXY) return;
  const ip = lanIp();
  const publicHost = process.env.ANP_PUBLIC_HOST; // a domain or public IP (for port-forwarding / internet use)
  if (!ip && !publicHost && !process.env.ANP_TLS_CERT) return;
  void startHttps(ip, publicHost);
});

const isIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

async function startHttps(lan: string | undefined, publicHost: string | undefined): Promise<void> {
  try {
    const httpsPort = Number(process.env.ANP_HTTPS_PORT ?? PORT + 1);
    let key: string;
    let cert: string;

    if (process.env.ANP_TLS_CERT && process.env.ANP_TLS_KEY) {
      // bring-your-own real certificate (e.g. your domain) — no browser warning
      cert = await readFile(process.env.ANP_TLS_CERT, "utf8");
      key = await readFile(process.env.ANP_TLS_KEY, "utf8");
    } else {
      // locally-generated self-signed cert covering localhost, the LAN IP and
      // any public host you set (so port-forwarding to your IP/domain works)
      const selfsigned = (await import("selfsigned")).default as unknown as {
        generate: (attrs: unknown, opts: unknown) => { private: string; cert: string } | Promise<{ private: string; cert: string }>;
      };
      const altNames: Array<{ type: number; ip?: string; value?: string }> = [
        { type: 7, ip: "127.0.0.1" },
        { type: 2, value: "localhost" },
      ];
      if (lan) altNames.push({ type: 7, ip: lan });
      if (publicHost) altNames.push(isIp(publicHost) ? { type: 7, ip: publicHost } : { type: 2, value: publicHost });
      const cn = publicHost ?? lan ?? "localhost";
      const pems = await selfsigned.generate([{ name: "commonName", value: cn }], {
        days: 3650,
        keySize: 2048,
        extensions: [{ name: "subjectAltName", altNames }],
      });
      key = pems.private;
      cert = pems.cert;
    }

    const httpsServer = createHttpsServer({ key, cert }, handleHttp);
    attachWs(httpsServer);
    httpsServer.on("error", () => {}); // port busy etc. — ignore, http still works
    httpsServer.listen(httpsPort, "0.0.0.0", async () => {
      const selfSigned = !(process.env.ANP_TLS_CERT && process.env.ANP_TLS_KEY);
      const lanUrl = lan ? `https://${lan}:${httpsPort}/` : undefined;
      const pubUrl = publicHost ? `https://${publicHost}:${httpsPort}/` : undefined;
      const warn = selfSigned ? "（初回のみ証明書の警告を「続行/アクセスする」）" : "";
      console.log(`[anp-relay] https :${httpsPort}  (${selfSigned ? "自己署名" : "持ち込み証明書"})\n`);
      if (lanUrl) {
        console.log(`  📱 同じWi-Fiのスマホ/PCから: ${lanUrl}  ${warn}`);
      }
      if (pubUrl) {
        console.log(`  🌍 別ネットワークから（要ポート開放 / 公開IP・ドメイン）: ${pubUrl}  ${warn}`);
      }
      console.log("");
      // QR of the most "reachable" URL to open on a phone
      const qrUrl = pubUrl ?? lanUrl;
      if (qrUrl) {
        try {
          const qrcode = (await import("qrcode-terminal")).default;
          qrcode.generate(qrUrl, { small: true });
          console.log(`  ↑ スマホのカメラでこのQRを読み取ってもOK\n`);
        } catch {
          /* qr optional */
        }
      }
    });
  } catch (err) {
    console.log(`[anp-relay] https を起動できませんでした: ${(err as Error).message}`);
  }
}

async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* headless / no browser — fine */
  }
}
