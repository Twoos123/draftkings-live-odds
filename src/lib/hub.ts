import type { TickSink } from "./clickhouse";
import type { Feed, FeedHandlers } from "./dk/feed";
import type { DkDelta, DkSnapshot, DkUpdateMeta, ParseIssue } from "./dk/schema";
import { diffGames, normalizeGame, normalizeGames, sideKey, sortGames, withSource, type GamesDiff } from "./odds/normalize";
import { DkStore } from "./odds/store";
import type { FeedHealth, FeedStatus, Game, Price, StreamMessage } from "./odds/types";
import { RollingWindow } from "./stats";

export interface HubDeps {
  fetchSnapshot(onIssue: ParseIssue): Promise<DkSnapshot>;
  createFeed(handlers: FeedHandlers): Feed;
  sink: TickSink;
  now(): number;
  instanceId: string;
}

export interface HubOptions {
  /** REST re-check while the push feed is healthy (catches anything the deltas missed). */
  resyncIntervalMs: number;
  /** REST polling while the push feed is down, so the board keeps moving. */
  fallbackPollMs: number;
  /** Status heartbeat to browsers; also how they notice a dead connection. */
  statusIntervalMs: number;
  /** Keep the DK connection this long after the last viewer leaves. */
  idleShutdownMs: number;
  /** Fetch the snapshot anyway if the push feed isn't up by then. */
  firstSnapshotGraceMs: number;
  /** Min gap between resyncs triggered by updates we couldn't place. */
  unresolvedResyncMs: number;
  /** Deltas this recent are replayed onto a new snapshot (DK caches the REST response for 1s). */
  replayWindowMs: number;
}

const DEFAULTS: HubOptions = {
  resyncIntervalMs: 60_000,
  fallbackPollMs: 10_000,
  statusIntervalMs: 5_000,
  idleShutdownMs: 60_000,
  firstSnapshotGraceMs: 3_000,
  unresolvedResyncMs: 10_000,
  replayWindowMs: 5_000,
};

/** If our 1s timer hasn't fired for this long, the instance was frozen between requests. */
const FROZEN_AFTER_MS = 5_000;

/**
 * Receives each message plus its ready-to-write SSE frame. The frame is
 * encoded once per broadcast and shared by every viewer on this instance.
 */
export type Listener = (msg: StreamMessage, frame: Uint8Array) => void;

const encoder = new TextEncoder();

export function encodeFrame(msg: StreamMessage): Uint8Array {
  return encoder.encode(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
}

type RecomputeSource = "ws" | "resync" | "snapshot";

/**
 * One per server instance. Holds a single DraftKings push-feed connection and
 * the current board, and fans updates out to every browser connected to this
 * instance. Starts on the first viewer and shuts down after the last leaves,
 * which suits Vercel: there is no always-on process, but concurrent requests
 * on a warm instance share this object.
 */
export class OddsHub {
  private store = new DkStore();
  /** Normalized board, without prev/changedAt decoration. Diffed on every change. */
  private board = new Map<string, Game>();
  private history = new Map<string, { prev: Price; changedAt: string }>();
  private listeners = new Set<Listener>();
  private feed: Feed | null = null;
  private recent: { at: number; delta: DkDelta }[] = [];
  private resyncBuffer: DkDelta[] | null = null;
  private resyncPromise: Promise<boolean> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTickAt = 0;
  private lastStatusAt = 0;
  private lastSnapshotAttemptAt = 0;
  private lastUnresolvedResyncAt = 0;
  private snapshotFailures = 0;
  private hasData = false;
  private lastSnapshotAt: number | null = null;
  private lastMessageAt: number | null = null;
  private snapshotError: string | null = null;
  private lastError: string | null = null;
  /**
   * DraftKings' clock minus ours. Every timestamp we emit is on DK's clock, so
   * latency against DK's own timestamps is right even if this host's clock
   * drifts (a PC without NTP can be off by hundreds of ms). ~0 on Vercel.
   */
  private dkClockOffsetMs = 0;
  private readonly dkToServer = new RollingWindow();
  private readonly wire = new RollingWindow();
  private readonly counters: FeedStatus["counters"] = {
    updates: 0,
    moves: 0,
    resyncs: 0,
    resyncCorrections: 0,
    unresolved: 0,
    parseIssues: 0,
    reconnects: 0,
  };
  private readonly opts: HubOptions;

  constructor(
    private readonly deps: HubDeps,
    opts: Partial<HubOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Stream the board to `listener`: current snapshot now, then updates and status heartbeats. */
  subscribe(listener: Listener, opts: { resync?: boolean } = {}): () => void {
    this.listeners.add(listener);
    clearTimeout(this.idleTimer);
    if (this.feed && this.deps.now() - this.lastTickAt > FROZEN_AFTER_MS) {
      // Timers didn't run, so we may have missed updates and the socket may be
      // dead. Reconnecting re-subscribes, which triggers a fresh snapshot.
      this.lastError = "Instance was paused; reconnecting to DraftKings";
      this.feed.reconnect();
    }
    this.start();
    const initial = this.hasData ? this.snapshotMessage() : this.statusMessage();
    this.send(listener, initial, encodeFrame(initial));
    if (opts.resync) void this.resync();
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

  /** Board for one-off requests (the JSON API). Re-fetches unless we're live or it's recent. */
  async getBoard(maxAgeMs: number): Promise<{ games: Game[]; status: FeedStatus }> {
    const age = this.lastSnapshotAt === null ? Infinity : this.deps.now() - this.lastSnapshotAt;
    if (maxAgeMs === 0 || (this.status().health !== "live" && age > maxAgeMs)) await this.resync();
    return { games: this.games(), status: this.status() };
  }

  stop() {
    this.feed?.stop();
    this.feed = null;
    clearInterval(this.tickTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.idleTimer);
  }

  /**
   * Fetch a full snapshot and swap it in. Concurrent calls share one request.
   * Deltas that arrived just before or during the request are replayed on
   * top: every DK change is "set this field", so re-applying is safe.
   */
  resync(): Promise<boolean> {
    if (this.resyncPromise) return this.resyncPromise;
    const startedAt = this.deps.now();
    this.lastSnapshotAttemptAt = startedAt;
    this.resyncBuffer = this.recent.filter((r) => startedAt - r.at <= this.opts.replayWindowMs).map((r) => r.delta);
    this.resyncPromise = (async () => {
      try {
        const snapshot = await this.deps.fetchSnapshot(this.onParseIssue);
        const fresh = DkStore.fromSnapshot(snapshot);
        for (const delta of this.resyncBuffer ?? []) fresh.apply(delta);
        this.store = fresh;
        const at = this.deps.now();
        this.lastSnapshotAt = at;
        this.snapshotError = null;
        this.snapshotFailures = 0;
        this.counters.resyncs++;
        this.recompute(this.hasData ? "resync" : "snapshot", null, at);
        return true;
      } catch (err) {
        this.snapshotFailures++;
        this.snapshotError = err instanceof Error ? err.message : String(err);
        return false;
      } finally {
        this.resyncBuffer = null;
        this.resyncPromise = null;
        this.broadcastStatus();
      }
    })();
    return this.resyncPromise;
  }

  games(): Game[] {
    return sortGames([...this.board.values()].map((g) => this.decorate(g)));
  }

  status(): FeedStatus {
    const now = this.deps.now();
    const subscribed = this.feed?.subscribed ?? false;
    const snapshotAge = this.lastSnapshotAt === null ? Infinity : now - this.lastSnapshotAt;
    let health: FeedHealth;
    if (!this.hasData) health = this.snapshotFailures > 0 ? "down" : "starting";
    else if (subscribed && snapshotAge <= this.opts.resyncIntervalMs * 3) health = "live";
    // Push feed up but REST checks failing, or push feed down but polling is keeping up.
    else if (subscribed || snapshotAge <= this.opts.fallbackPollMs * 3) health = "degraded";
    else health = "stale";
    const iso = (t: number | null) => (t === null ? null : this.iso(t));
    return {
      health,
      serverTime: this.iso(now),
      dkClockOffsetMs: this.dkClockOffsetMs,
      instanceId: this.deps.instanceId,
      ws: this.feed?.state ?? "idle",
      subscribed,
      lastMessageAt: iso(this.lastMessageAt),
      lastSnapshotAt: iso(this.lastSnapshotAt),
      snapshotError: this.snapshotError,
      lastError: this.lastError,
      dkToServerMs: this.dkToServer.stats(),
      wireMs: this.wire.stats(),
      counters: { ...this.counters },
      sink: this.deps.sink.status(),
    };
  }

  private start() {
    if (this.feed) return;
    this.feed = this.deps.createFeed({
      onState: (state) => {
        if (state === "closed") this.counters.reconnects++;
        this.broadcastStatus();
      },
      onSubscribed: (clock) => {
        // NTP-style: DK answered roughly halfway through the round trip.
        if (clock) this.dkClockOffsetMs = Math.round(clock.dkTime - (clock.sentAt + clock.receivedAt) / 2);
        void this.resync();
      },
      onUpdate: (delta, meta, receivedAt) => this.ingest(delta, meta, receivedAt),
      onError: (message) => {
        this.lastError = message;
      },
      onParseIssue: this.onParseIssue,
    });
    this.feed.start();
    this.lastTickAt = this.deps.now();
    // The snapshot waits for the subscription ack (or the grace timer), not the first tick.
    this.lastSnapshotAttemptAt = this.lastTickAt;
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.graceTimer = setTimeout(() => {
      if (!this.feed?.subscribed && !this.hasData) void this.resync();
    }, this.opts.firstSnapshotGraceMs);
  }

  private tick() {
    const now = this.deps.now();
    this.lastTickAt = now;
    if (now - this.lastStatusAt >= this.opts.statusIntervalMs) this.broadcastStatus();
    const base = this.feed?.subscribed ? this.opts.resyncIntervalMs : this.opts.fallbackPollMs;
    const backoff = Math.min(base * 2 ** Math.min(this.snapshotFailures, 3), 60_000);
    if (now - this.lastSnapshotAttemptAt >= backoff) void this.resync();
  }

  /** Apply one push-feed update. Public so the dev-only simulator can use the same path. */
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
    this.deps.sink.recordLatency(meta, receivedOnDkClock, this.deps.instanceId);

    this.recent.push({ at: receivedAt, delta });
    while (this.recent.length && receivedAt - this.recent[0].at > this.opts.replayWindowMs) this.recent.shift();
    this.resyncBuffer?.push(delta);
    if (!this.hasData) return; // the first snapshot will replay it

    const result = this.store.apply(delta);
    if (result.unresolved.length) {
      this.counters.unresolved += result.unresolved.length;
      if (receivedAt - this.lastUnresolvedResyncAt >= this.opts.unresolvedResyncMs) {
        this.lastUnresolvedResyncAt = receivedAt;
        void this.resync();
      }
    }
    if (result.touched.size) this.recompute("ws", meta, receivedAt, result.touched);
  }

  /**
   * Re-derive the board after the store changed and broadcast the difference.
   * A push update passes the games it touched, so only those are rebuilt and
   * compared; snapshots and resyncs rebuild everything.
   */
  private recompute(source: RecomputeSource, meta: DkUpdateMeta | null, receivedAt: number, touched?: Set<string>) {
    let diff: GamesDiff;
    if (touched) {
      const before = new Map<string, Game>();
      for (const id of touched) {
        const old = this.board.get(id);
        if (old) before.set(id, old);
        const game = normalizeGame(this.store, id);
        if (game) this.board.set(id, game);
        else this.board.delete(id);
      }
      diff = diffGames(before, this.board, touched);
    } else {
      const rebuilt = normalizeGames(this.store);
      diff = diffGames(this.board, rebuilt);
      this.board = rebuilt;
    }
    const next = this.board;

    if (source === "snapshot") {
      this.hasData = true;
      this.deps.sink.recordBoard(next.values(), this.dkTime(receivedAt));
      this.broadcast(this.snapshotMessage());
      return;
    }

    const moves = withSource(diff.moves, source === "ws" ? "ws" : "resync");
    const changedAt = meta?.createdTime ?? this.iso(receivedAt);
    for (const m of moves) this.history.set(sideKey(m.gameId, m.market, m.side), { prev: m.from, changedAt });
    for (const id of diff.removed) {
      for (const key of this.history.keys()) if (key.startsWith(`${id}:`)) this.history.delete(key);
    }
    if (source === "ws") this.counters.moves += moves.length;
    else this.counters.resyncCorrections += moves.length;
    if (moves.length) this.deps.sink.recordMoves(moves, next, meta, this.dkTime(receivedAt));

    if (diff.changed.length || diff.removed.length) {
      this.broadcast({
        type: "update",
        games: diff.changed.map((id) => this.decorate(next.get(id)!)),
        removed: diff.removed,
        moves,
        timing: meta
          ? { dkCreatedAt: meta.createdTime, dkPublishedAt: meta.publishedTime, serverReceivedAt: this.iso(receivedAt) }
          : null,
        sentAt: this.iso(this.deps.now()),
      });
    }
  }

  private decorate(game: Game): Game {
    const markets: Game["markets"] = {};
    for (const m of Object.values(game.markets)) {
      markets[m!.type] = {
        ...m!,
        selections: m!.selections.map((s) => {
          const h = this.history.get(sideKey(game.id, m!.type, s.side));
          return h ? { ...s, prev: h.prev, changedAt: h.changedAt } : s;
        }),
      };
    }
    return { ...game, markets };
  }

  private onParseIssue: ParseIssue = () => {
    this.counters.parseIssues++;
  };

  private snapshotMessage(): StreamMessage {
    return { type: "snapshot", games: this.games(), status: this.status(), sentAt: this.iso(this.deps.now()) };
  }

  private statusMessage(): StreamMessage {
    return { type: "status", status: this.status(), sentAt: this.iso(this.deps.now()) };
  }

  /** Current time on DraftKings' clock. /api/time serves this so browsers align to it too. */
  now(): number {
    return this.dkTime(this.deps.now());
  }

  private dkTime(t: number): number {
    return t + this.dkClockOffsetMs;
  }

  private iso(t: number): string {
    return new Date(this.dkTime(t)).toISOString();
  }

  private broadcastStatus() {
    this.lastStatusAt = this.deps.now();
    if (this.listeners.size) this.broadcast(this.statusMessage());
  }

  private broadcast(msg: StreamMessage) {
    if (this.listeners.size === 0) return;
    const frame = encodeFrame(msg); // once, however many viewers
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
}
