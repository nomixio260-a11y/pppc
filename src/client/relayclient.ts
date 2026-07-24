/**
 * Relay client (design doc §6, §14.3), protocol v2.
 *
 * Connects to one or more relays over WebSocket, publishes signed events to
 * ALL of them, and subscribes on all of them, de-duplicating incoming events
 * by id. Using multiple relays means no single relay can partition or forge
 * the view (events are signed, so a relay can at worst hide them).
 *
 * v2 hardening:
 *  - publish queue: events published while a socket is down are buffered
 *    (until their expiry) and flushed on reconnect, so a relay flap can no
 *    longer silently drop a JOIN or SIGNAL
 *  - jittered exponential reconnect backoff (no thundering herd)
 *  - per-relay statistics for the UI (§14.3: watch relays for divergence)
 */

import { verifyEvent } from "../shared/events.js";
import { nowSeconds } from "../shared/crypto.js";
import type { AnpEvent, ClientFrame, EventFilter, RelayFrame } from "../shared/types.js";

export interface RelayStats {
  url: string;
  connected: boolean;
  eventsReceived: number;
  eventsAccepted: number;
  eventsRejected: number;
  lastEventAt: number;
  lastError?: string;
}

export interface RelayClientOptions {
  urls: string[];
  filter: EventFilter;
  onEvent: (event: AnpEvent, relayUrl: string) => void;
  onStatus?: (relayUrl: string, connected: boolean) => void;
}

const BACKOFF_BASE_MS = 1_500;
const BACKOFF_MAX_MS = 30_000;
const MAX_QUEUED = 256;
const MAX_SEEN_IDS = 10_000;

interface RelayConn {
  url: string;
  ws?: WebSocket;
  attempts: number;
  /** events waiting for this relay to come back */
  queue: AnpEvent[];
  stats: RelayStats;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export class RelayPool {
  private conns = new Map<string, RelayConn>();
  private seen = new Set<string>();
  private closed = false;

  constructor(private readonly opts: RelayClientOptions) {}

  start(): void {
    for (const url of this.opts.urls) this.addRelay(url);
  }

  /** Add and connect a relay at runtime (bootstrap adoption / manual edit). */
  addRelay(url: string): void {
    if (this.closed || this.conns.has(url)) return;
    const conn: RelayConn = {
      url,
      attempts: 0,
      queue: [],
      stats: {
        url,
        connected: false,
        eventsReceived: 0,
        eventsAccepted: 0,
        eventsRejected: 0,
        lastEventAt: 0,
      },
    };
    this.conns.set(url, conn);
    this.connect(conn);
  }

  /** Remove a relay at runtime (manual edit). */
  removeRelay(url: string): void {
    const conn = this.conns.get(url);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.ws?.close();
    this.conns.delete(url);
  }

  stop(): void {
    this.closed = true;
    for (const conn of this.conns.values()) {
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      conn.ws?.close();
    }
    this.conns.clear();
  }

  connectedCount(): number {
    let n = 0;
    for (const conn of this.conns.values()) if (conn.stats.connected) n++;
    return n;
  }

  statsSnapshot(): RelayStats[] {
    return [...this.conns.values()].map((c) => ({ ...c.stats }));
  }

  private scheduleReconnect(conn: RelayConn): void {
    if (this.closed) return;
    conn.attempts += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (conn.attempts - 1));
    const jitter = delay * (0.5 + Math.random() * 0.5);
    conn.reconnectTimer = setTimeout(() => this.connect(conn), jitter);
  }

  private connect(conn: RelayConn): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(conn.url);
    } catch (err) {
      conn.stats.lastError = (err as Error).message;
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;

    ws.onopen = () => {
      conn.attempts = 0;
      conn.stats.connected = true;
      conn.stats.lastError = undefined;
      this.opts.onStatus?.(conn.url, true);
      this.sendFrame(ws, { frame: "REQ", sub_id: "main", filter: this.opts.filter });
      // flush events that were published while this relay was down
      const now = nowSeconds();
      const queued = conn.queue.splice(0);
      for (const event of queued) {
        if (event.expires_at > now) this.sendFrame(ws, { frame: "EVENT", event });
      }
    };
    ws.onmessage = async (msg) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(msg.data)) as RelayFrame;
      } catch {
        return;
      }
      if (frame.frame === "OK") {
        if (frame.accepted) conn.stats.eventsAccepted++;
        else {
          conn.stats.eventsRejected++;
          conn.stats.lastError = frame.message;
        }
        return;
      }
      if (frame.frame === "EVENT") {
        const event = frame.event;
        conn.stats.eventsReceived++;
        conn.stats.lastEventAt = nowSeconds();
        if (this.seen.has(event.id)) return;
        // Never trust the relay: re-verify every event locally (§14.1).
        // PoW is not re-checked here (powBits: 0) — invite chains gate
        // membership; the relay-side PoW gate is anti-spam for storage.
        const check = await verifyEvent(event, { powBits: 0 });
        if (!check.ok) return;
        if (this.seen.has(event.id)) return; // re-check after await
        this.seen.add(event.id);
        if (this.seen.size > MAX_SEEN_IDS) {
          const ids = [...this.seen];
          this.seen = new Set(ids.slice(ids.length / 2));
        }
        this.opts.onEvent(event, conn.url);
      }
    };
    ws.onclose = () => {
      conn.stats.connected = false;
      if (conn.ws === ws) conn.ws = undefined;
      this.opts.onStatus?.(conn.url, false);
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {
      conn.stats.lastError = "socket error";
      ws.close();
    };
  }

  /** Publish to every relay; queues for relays that are currently down. */
  publish(event: AnpEvent): void {
    this.seen.add(event.id); // don't re-process our own events
    for (const conn of this.conns.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        this.sendFrame(conn.ws, { frame: "EVENT", event });
      } else {
        conn.queue.push(event);
        if (conn.queue.length > MAX_QUEUED) conn.queue.shift();
      }
    }
  }

  private sendFrame(ws: WebSocket, frame: ClientFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* reconnect loop will recover */
    }
  }
}
