/**
 * Relay client (design doc §6, §14.3).
 *
 * Connects to one or more relays over WebSocket, publishes signed events to
 * ALL of them, and subscribes on all of them, de-duplicating incoming events
 * by id. Using multiple relays means no single relay can partition or forge
 * the view (events are signed, so a relay can at worst hide them).
 */

import { verifyEvent } from "../shared/events.js";
import type { AnpEvent, ClientFrame, EventFilter, RelayFrame } from "../shared/types.js";

export interface RelayClientOptions {
  urls: string[];
  filter: EventFilter;
  onEvent: (event: AnpEvent, relayUrl: string) => void;
  onStatus?: (relayUrl: string, connected: boolean) => void;
}

const RECONNECT_MS = 3000;

export class RelayPool {
  private sockets = new Map<string, WebSocket>();
  private seen = new Set<string>();
  private closed = false;

  constructor(private readonly opts: RelayClientOptions) {}

  start(): void {
    for (const url of this.opts.urls) this.connect(url);
  }

  stop(): void {
    this.closed = true;
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }

  connectedCount(): number {
    let n = 0;
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  private connect(url: string): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setTimeout(() => this.connect(url), RECONNECT_MS);
      return;
    }
    this.sockets.set(url, ws);

    ws.onopen = () => {
      this.opts.onStatus?.(url, true);
      this.sendFrame(ws, { frame: "REQ", sub_id: "main", filter: this.opts.filter });
    };
    ws.onmessage = async (msg) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(msg.data)) as RelayFrame;
      } catch {
        return;
      }
      if (frame.frame === "EVENT") {
        const event = frame.event;
        if (this.seen.has(event.id)) return;
        // Never trust the relay: re-verify every event locally (§14.1).
        const check = await verifyEvent(event);
        if (!check.ok) return;
        this.seen.add(event.id);
        if (this.seen.size > 10_000) {
          // bounded memory: drop the oldest half
          const ids = [...this.seen];
          this.seen = new Set(ids.slice(ids.length / 2));
        }
        this.opts.onEvent(event, url);
      }
    };
    ws.onclose = () => {
      this.opts.onStatus?.(url, false);
      this.sockets.delete(url);
      if (!this.closed) setTimeout(() => this.connect(url), RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  }

  /** Publish to every connected relay. */
  publish(event: AnpEvent): void {
    this.seen.add(event.id); // don't re-process our own events
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) this.sendFrame(ws, { frame: "EVENT", event });
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
