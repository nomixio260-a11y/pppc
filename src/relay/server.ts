/**
 * ANP Relay (design doc §7).
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
 * Wire protocol (Nostr-like):
 *   client -> relay: {frame:"EVENT",event} | {frame:"REQ",sub_id,filter} | {frame:"CLOSE",sub_id}
 *   relay -> client: {frame:"EVENT",sub_id,event} | {frame:"EOSE",sub_id}
 *                  | {frame:"OK",event_id,accepted,message} | {frame:"NOTICE",message}
 *
 * Also serves the browser client from ./public for a one-command demo.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { verifyEvent } from "../shared/events.js";
import { nowSeconds } from "../shared/crypto.js";
import type { AnpEvent, ClientFrame, EventFilter, RelayFrame } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = new URL("../../public", import.meta.url).pathname;
const MAX_EVENTS_PER_NETWORK = 5000;
const MAX_FRAME_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

class EventStore {
  /** network_id -> event_id -> event */
  private networks = new Map<string, Map<string, AnpEvent>>();

  add(event: AnpEvent): boolean {
    let bucket = this.networks.get(event.network_id);
    if (!bucket) {
      bucket = new Map();
      this.networks.set(event.network_id, bucket);
    }
    if (bucket.has(event.id)) return false;
    if (bucket.size >= MAX_EVENTS_PER_NETWORK) this.evictOldest(bucket);
    // A node's newer JOIN/HEARTBEAT/MANIFEST supersedes its older one.
    if (event.type !== "SIGNAL") {
      for (const [id, existing] of bucket) {
        if (existing.node_id === event.node_id && existing.type === event.type) bucket.delete(id);
      }
    }
    bucket.set(event.id, event);
    return true;
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
      if (bucket.size === 0) this.networks.delete(networkId);
    }
    return dropped;
  }

  stats(): { networks: number; events: number } {
    let events = 0;
    for (const bucket of this.networks.values()) events += bucket.size;
    return { networks: this.networks.size, events };
  }

  private evictOldest(bucket: Map<string, AnpEvent>): void {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, event] of bucket) {
      if (event.created_at < oldestAt) {
        oldestAt = event.created_at;
        oldestId = id;
      }
    }
    if (oldestId) bucket.delete(oldestId);
  }
}

function matches(event: AnpEvent, filter: EventFilter, now: number): boolean {
  if (event.expires_at <= now) return false;
  if (event.network_id !== filter.network_id) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.node_id && event.node_id !== filter.node_id) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (event.type === "SIGNAL") {
    // SIGNAL events are point-to-point: only deliver to their target
    // (or to explicit node_id queries by the sender for debugging).
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
  const check = await verifyEvent(event);
  if (!check.ok) return { accepted: false, message: check.reason };
  const fresh = store.add(event);
  if (fresh) {
    const now = nowSeconds();
    for (const sub of subscriptions) {
      if (sub.ws.readyState === WebSocket.OPEN && matches(event, sub.filter, now)) {
        send(sub.ws, { frame: "EVENT", sub_id: sub.subId, event });
      }
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

const httpServer = createServer(async (req, res) => {
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
      const event = JSON.parse(await readBody(req)) as AnpEvent;
      const result = await ingest(event);
      return json(res, result.accepted ? 200 : 400, result);
    }
    if (req.method === "GET" && url.pathname === "/events") {
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
      return json(res, 200, { ok: true, ...store.stats() });
    }
    // static client
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const path = normalize(join(PUBLIC_DIR, rel));
      if (!path.startsWith(normalize(PUBLIC_DIR))) {
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
});

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });

wss.on("connection", (ws) => {
  const mySubs = new Set<Subscription>();

  ws.on("message", async (raw) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame;
    } catch {
      return send(ws, { frame: "NOTICE", message: "invalid json" });
    }
    if (frame.frame === "EVENT") {
      const result = await ingest(frame.event);
      send(ws, {
        frame: "OK",
        event_id: frame.event?.id ?? "",
        accepted: result.accepted,
        message: result.message,
      });
    } else if (frame.frame === "REQ") {
      if (!frame.filter?.network_id || typeof frame.sub_id !== "string") {
        return send(ws, { frame: "NOTICE", message: "REQ requires sub_id and filter.network_id" });
      }
      // replace an existing subscription with the same id
      for (const sub of mySubs) {
        if (sub.subId === frame.sub_id) {
          mySubs.delete(sub);
          subscriptions.delete(sub);
        }
      }
      const sub: Subscription = { ws, subId: frame.sub_id, filter: frame.filter };
      mySubs.add(sub);
      subscriptions.add(sub);
      for (const event of store.query(frame.filter)) {
        send(ws, { frame: "EVENT", sub_id: frame.sub_id, event });
      }
      send(ws, { frame: "EOSE", sub_id: frame.sub_id });
    } else if (frame.frame === "CLOSE") {
      for (const sub of mySubs) {
        if (sub.subId === frame.sub_id) {
          mySubs.delete(sub);
          subscriptions.delete(sub);
        }
      }
    } else {
      send(ws, { frame: "NOTICE", message: "unknown frame" });
    }
  });

  ws.on("close", () => {
    for (const sub of mySubs) subscriptions.delete(sub);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[anp-relay] listening on http://localhost:${PORT}`);
  console.log(`[anp-relay] ws endpoint  ws://localhost:${PORT}`);
  console.log(`[anp-relay] client UI    http://localhost:${PORT}/`);
});
