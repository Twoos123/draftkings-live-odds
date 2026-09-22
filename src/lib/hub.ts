import type { TickSink } from "./clickhouse";
import type { Feed, FeedHandlers } from "./dk/feed";
import type { DkDelta, DkSnapshot, DkUpdateMeta, ParseIssue } from "./dk/schema";
import { BoardEngine, type BoardChange } from "./odds/engine";
import type { FeedHealth, FeedStatus, Game, StreamMessage } from "./odds/types";
import { RollingWindow } from "./stats";

export interface HubDeps {
  fetchSnapshot(onIssue: ParseIssue): Promise<DkSnapshot>;
  createFeed(handlers: FeedHandlers): Feed;
  sink: TickSink;
  now(): number;
  instanceId: string;
}

export interface HubOptions {
  /** Server-board REST check while the push feed is up. */
  resyncIntervalMs: number;
  /** Server-board REST polling while the push feed is down. */
  fallbackPollMs: number;
  /** Status heartbeat to browsers; also how they notice a dead connection. */
  statusIntervalMs: number;
  /** Keep the DK connection this long after the last viewer leaves. */
  idleShutdownMs: number;
  /** Recent deltas replayed to a new viewer (and onto snapshots), so a board loaded a moment ago catches up. */
  replayWindowMs: number;
  /** How long the push feed can be down before we call it down rather than reconnecting. */
  downAfterMs: number;
}

const DEFAULTS: HubOptions = {
  resyncIntervalMs: 60_000,
  fallbackPollMs: 10_000,
  statusIntervalMs: 5_000,
  idleShutdownMs: 60_000,
  replayWindowMs: 10_000,
  downAfterMs: 30_000,
};

/** If our 1s timer hasn't fired for this long, the instance was frozen between requests. */
const FROZEN_AFTER_MS = 5_000;

/**
 * Receives each message plus its ready-to-write SSE frame. The frame is
 * encoded once per broadcast and shared by every viewer on this instance.
 */
export type Listener = (msg: StreamMessage, frame: Uint8Array) => void;

const encoder = new TextEncoder();

/** `event` defaults to the message type; catch-up deltas go out as `replay` so browsers don't time them. */
export function encodeFrame(msg: StreamMessage, event: string = msg.type): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(msg)}\n\n`);
}

/**
 * One per server instance. Holds a single connection to DraftKings' push feed
 * and relays every update, as-is, to all browsers on this instance over SSE.
 * Each browser applies them to the board it loaded from DraftKings itself (DK
 * blocks cloud IPs from its REST board, but not from this feed).
 *
 * Where the server *can* reach the REST board (e.g. local dev), it also keeps
 * its own copy via the same BoardEngine, for /api/odds and ClickHouse.
 *
 * Starts on the first viewer and stops after the last leaves, which suits
 * Vercel: no always-on process, but concurrent requests on a warm instance
 * share this object.
 */
export class OddsHub {
  private readonly engine: BoardEngine;
  private listeners = new Set<Listener>();
  private feed: Feed | null = null;
  private recent: { at: number; msg: StreamMessage }[] = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTickAt = 0;
  private lastStatusAt = 0;
  private lastMessageAt: number | null = null;
  private everSubscribed = false;
  private subscribedAt: number | null = null;
  /** When the push feed last stopped being subscribed (or first started connecting). */
  private downSince: number | null = null;
  private lastError: string | null = null;
  /**
   * DraftKings' clock minus ours. Every timestamp we emit is on DK's clock, so
   * latency against DK's own timestamps is right even if this host's clock
   * drifts (a PC without NTP can be off by hundreds of ms). ~0 on Vercel.
   */
  private dkClockOffsetMs = 0;
  private readonly dkToServer = new RollingWindow();
  private readonly wire = new RollingWindow();
  private readonly dkInternal = new RollingWindow();
  private readonly counters: FeedStatus["counters"] = { updates: 0, parseIssues: 0, reconnects: 0 };
  private readonly opts: HubOptions;

  constructor(
    private readonly deps: HubDeps,
    opts: Partial<HubOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.engine = new BoardEngine({
      fetchSnapshot: deps.fetchSnapshot,
      now: deps.now,
      toIso: (t) => this.iso(t),
      onParseIssue: this.onParseIssue,
      replayWindowMs: this.opts.replayWindowMs,
      onChange: (change, meta, receivedAt) => this.recordServerBoard(change, meta, receivedAt),
    });
  }

  /** Stream to `listener`: a status now, recent deltas to catch up on, then live deltas and heartbeats. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    clearTimeout(this.idleTimer);
    if (this.feed && this.deps.now() - this.lastTickAt > FROZEN_AFTER_MS) {
      // Timers didn't run, so the socket may be dead and we may have missed updates.
      this.lastError = "Instance was paused; reconnecting to DraftKings";
      this.feed.reconnect();
    }
    this.start();
    const status = this.statusMessage();
    this.send(listener, status, encodeFrame(status));
    const now = this.deps.now();
    for (const r of this.recent) if (now - r.at <= this.opts.replayWindowMs) this.send(listener, r.msg, encodeFrame(r.msg, "replay"));
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          if (this.listeners.size === 0) this.stop();
        }, this.opts.idleShutdownMs);
      }
    };
  }

  /** The server's own board for /api/odds. Re-fetches unless the push feed is keeping it current. */
  async getBoard(maxAgeMs: number) {
    const age = this.engine.lastSnapshotAt === null ? Infinity : this.deps.now() - this.engine.lastSnapshotAt;
    const live = this.engine.hasData && (this.feed?.subscribed ?? false);
    if (maxAgeMs === 0 || (!live && age > maxAgeMs)) await this.engine.resync();
    return {
      games: this.engine.games(),
      asOf: this.engine.lastSnapshotAt === null ? null : this.iso(this.engine.lastSnapshotAt),
      error: this.engine.snapshotError,
      status: this.status(),
    };
  }

  games(): Game[] {
    return this.engine.games();
  }

  stop() {
    this.feed?.stop();
    this.feed = null;
    clearInterval(this.tickTimer);
    clearTimeout(this.idleTimer);
  }

  status(): FeedStatus {
    const now = this.deps.now();
    const subscribed = this.feed?.subscribed ?? false;
    let health: FeedHealth;
    if (!this.feed) health = "idle";
    else if (subscribed) health = "live";
    else if (this.downSince !== null && now - this.downSince > this.opts.downAfterMs) health = "down";
    else health = this.everSubscribed ? "reconnecting" : "starting";
    const iso = (t: number | null) => (t === null ? null : this.iso(t));
    return {
      health,
      serverTime: this.iso(now),
      dkClockOffsetMs: this.dkClockOffsetMs,
      instanceId: this.deps.instanceId,
      ws: this.feed?.state ?? "idle",
      subscribed,
      subscribedAt: subscribed ? iso(this.subscribedAt) : null,
      lastMessageAt: iso(this.lastMessageAt),
      lastError: this.lastError,
      dkToServerMs: this.dkToServer.stats(),
      wireMs: this.wire.stats(),
      dkInternalMs: this.dkInternal.stats(),
      counters: { ...this.counters },
      serverBoard: {
        lastSnapshotAt: iso(this.engine.lastSnapshotAt),
        snapshotError: this.engine.snapshotError,
        moves: this.engine.counters.moves,
        resyncCorrections: this.engine.counters.resyncCorrections,
      },
      sink: this.deps.sink.status(),
    };
  }

  /** Current time on DraftKings' clock. /api/time serves this so browsers align to it too. */
  now(): number {
    return this.dkTime(this.deps.now());
  }

  /** Apply one push-feed update: relay it to every browser, then update the server's own board. */
  ingest(delta: DkDelta, meta: DkUpdateMeta, receivedAt: number) {
    this.counters.updates++;
    this.lastMessageAt = receivedAt;
    if (meta.wsPublishedTime) {
      // A message can't arrive before DK sent it; if it seems to, our offset estimate is short.
      const wire = this.dkTime(receivedAt) - Date.parse(meta.wsPublishedTime);
      if (wire < 0) this.dkClockOffsetMs -= wire;
      this.wire.push(Math.max(0, wire));
    }
    const receivedOnDkClock = this.dkTime(receivedAt);
    if (meta.createdTime) this.dkToServer.push(receivedOnDkClock - Date.parse(meta.createdTime));
    // Both timestamps are DraftKings', so this needs no clock correction.
    if (meta.createdTime && meta.publishedTime) this.dkInternal.push(Date.parse(meta.publishedTime) - Date.parse(meta.createdTime));
    this.deps.sink.recordLatency(meta, receivedOnDkClock, this.deps.instanceId);

    const msg: StreamMessage = {
      type: "delta",
      delta,
      timing: { dkCreatedAt: meta.createdTime, dkPublishedAt: meta.publishedTime, serverReceivedAt: this.iso(receivedAt) },
      sentAt: this.iso(this.deps.now()),
    };
    const frame = encodeFrame(msg); // once, however many viewers
    this.recent.push({ at: receivedAt, msg });
    while (this.recent.length && receivedAt - this.recent[0].at > this.opts.replayWindowMs) this.recent.shift();
    for (const l of this.listeners) this.send(l, msg, frame);

    this.engine.apply(delta, meta, receivedAt);
  }

  private start() {
    if (this.feed) return;
    this.downSince = this.deps.now();
    this.feed = this.deps.createFeed({
      onState: (state) => {
        if (state === "closed") this.counters.reconnects++;
        if (state !== "open" && this.downSince === null) this.downSince = this.deps.now();
        this.broadcastStatus();
      },
      onSubscribed: (clock) => {
        // NTP-style: DK answered roughly halfway through the round trip.
        if (clock) this.dkClockOffsetMs = Math.round(clock.dkTime - (clock.sentAt + clock.receivedAt) / 2);
        this.everSubscribed = true;
        this.subscribedAt = this.deps.now();
        this.downSince = null;
        this.broadcastStatus();
        void this.engine.resync();
      },
      onUpdate: (delta, meta, receivedAt) => this.ingest(delta, meta, receivedAt),
      onError: (message) => {
        this.lastError = message;
      },
      onParseIssue: this.onParseIssue,
    });
    this.feed.start();
    this.lastTickAt = this.deps.now();
    // The first server-board fetch waits for the subscription ack, not the first tick.
    this.engine.lastSnapshotAttemptAt = this.lastTickAt;
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  private tick() {
    const now = this.deps.now();
    this.lastTickAt = now;
    if (now - this.lastStatusAt >= this.opts.statusIntervalMs) this.broadcastStatus();
    // Best effort: where DK blocks this server's IP (Vercel) this keeps failing, so back off to 5 min.
    const base = this.feed?.subscribed ? this.opts.resyncIntervalMs : this.opts.fallbackPollMs;
    const wait = Math.min(base * 2 ** Math.min(this.engine.snapshotFailures, 5), 5 * 60_000);
    if (now - this.engine.lastSnapshotAttemptAt >= wait) void this.engine.resync();
  }

  /** The server's own board only feeds ClickHouse; browsers build theirs from the relayed deltas. */
  private recordServerBoard(change: BoardChange, meta: DkUpdateMeta | null, receivedAt: number) {
    if (change.type === "snapshot") this.deps.sink.recordBoard(change.games, this.dkTime(receivedAt));
    else if (change.moves.length) this.deps.sink.recordMoves(change.moves, this.engine.gameMap(), meta, this.dkTime(receivedAt));
  }

  private onParseIssue: ParseIssue = () => {
    this.counters.parseIssues++;
  };

  private statusMessage(): StreamMessage {
    return { type: "status", status: this.status(), sentAt: this.iso(this.deps.now()) };
  }

  private broadcastStatus() {
    this.lastStatusAt = this.deps.now();
    if (this.listeners.size === 0) return;
    const msg = this.statusMessage();
    const frame = encodeFrame(msg);
    for (const l of this.listeners) this.send(l, msg, frame);
  }

  private send(listener: Listener, msg: StreamMessage, frame: Uint8Array) {
    try {
      listener(msg, frame);
    } catch {
      // A closed stream; its route handler unsubscribes it.
      this.listeners.delete(listener);
    }
  }

  private dkTime(t: number): number {
    return t + this.dkClockOffsetMs;
  }

  private iso(t: number): string {
    return new Date(this.dkTime(t)).toISOString();
  }
}
