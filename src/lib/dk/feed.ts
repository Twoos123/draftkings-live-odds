import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { subscribeMessage, wsUrl } from "./config";
import { parseWsMessage, type DkDelta, type DkUpdateMeta, type ParseIssue } from "./schema";

export type FeedState = "idle" | "connecting" | "open" | "closed";

/** One round trip to DraftKings, for estimating how far our clock is from theirs. */
export interface ClockSample {
  sentAt: number;
  receivedAt: number;
  /** DraftKings' clock when it answered, ms since epoch. */
  dkTime: number;
}

export interface FeedHandlers {
  onState(state: FeedState): void;
  /** Subscription acknowledged: from here on every change reaches us. */
  onSubscribed(clock?: ClockSample): void;
  onUpdate(delta: DkDelta, meta: DkUpdateMeta, receivedAt: number): void;
  onError(message: string): void;
  onParseIssue?: ParseIssue;
}

export interface Feed {
  start(): void;
  stop(): void;
  /** Drop the current socket and connect again (e.g. after the instance was frozen). */
  reconnect(): void;
  readonly state: FeedState;
  readonly subscribed: boolean;
}

export interface FeedOptions {
  url?: string;
  /** Ping DK this often; a missing pong means the socket is dead. */
  pingIntervalMs?: number;
  /** Give up on a connection that hasn't acked our subscription by then. */
  subscribeTimeoutMs?: number;
  maxBackoffMs?: number;
}

/** DraftKings push feed: one websocket, one subscription, reconnect with backoff. */
export class DkFeed implements Feed {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private awaitingPong = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private _state: FeedState = "idle";
  private _subscribed = false;
  private readonly opts: Required<FeedOptions>;

  constructor(private readonly handlers: FeedHandlers, opts: FeedOptions = {}) {
    this.opts = {
      url: opts.url ?? wsUrl(),
      pingIntervalMs: opts.pingIntervalMs ?? 15_000,
      subscribeTimeoutMs: opts.subscribeTimeoutMs ?? 10_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    };
  }

  get state() {
    return this._state;
  }

  get subscribed() {
    return this._subscribed;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.teardown();
    this.setState("idle");
  }

  reconnect() {
    if (this.stopped) return;
    this.teardown();
    this.connect();
  }

  private connect() {
    clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    const ws = new WebSocket(this.opts.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    const subId = randomUUID();
    let subscribeSentAt = 0;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.setState("open");
      subscribeSentAt = Date.now();
      ws.send(JSON.stringify(subscribeMessage(subId)));
      this.subscribeTimer = setTimeout(() => {
        this.handlers.onError("DraftKings did not acknowledge the subscription");
        ws.terminate();
      }, this.opts.subscribeTimeoutMs);
      this.awaitingPong = false;
      this.pingTimer = setInterval(() => {
        if (this.awaitingPong) {
          this.handlers.onError("DraftKings stopped answering pings");
          ws.terminate();
          return;
        }
        this.awaitingPong = true;
        ws.ping();
      }, this.opts.pingIntervalMs);
    });

    ws.on("pong", () => {
      this.awaitingPong = false;
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      const receivedAt = Date.now();
      const msg = parseWsMessage(data.toString(), this.handlers.onParseIssue);
      try {
        switch (msg.kind) {
          case "subscribed": {
            clearTimeout(this.subscribeTimer);
            this.attempts = 0;
            this._subscribed = true;
            const dkTime = msg.dkTime ? Date.parse(msg.dkTime) : NaN;
            this.handlers.onSubscribed(Number.isFinite(dkTime) ? { sentAt: subscribeSentAt, receivedAt, dkTime } : undefined);
            break;
          }
          case "update":
            this.handlers.onUpdate(msg.delta, msg.meta, receivedAt);
            break;
          case "error":
            this.handlers.onError(`DraftKings feed error: ${msg.message}`);
            break;
          case "invalid":
            this.handlers.onParseIssue?.("ws", msg.reason);
            break;
          case "other":
            break;
        }
      } catch (err) {
        // A bug in one update must not kill the connection.
        this.handlers.onError(`Failed to apply update: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on("error", (err) => {
      if (this.ws === ws) this.handlers.onError(`DraftKings websocket error: ${err.message}`);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.teardown();
      this.setState("closed");
      this.scheduleReconnect();
    });
  }

  private teardown() {
    clearTimeout(this.subscribeTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this._subscribed = false;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    // Exponential backoff with jitter: ~0.5s, 1s, 2s … capped at 30s.
    const ceiling = Math.min(this.opts.maxBackoffMs, 500 * 2 ** this.attempts);
    this.attempts++;
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(state: FeedState) {
    if (this._state === state) return;
    this._state = state;
    this.handlers.onState(state);
  }
}
