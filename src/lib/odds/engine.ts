import type { DkDelta, DkSnapshot, DkUpdateMeta, ParseIssue } from "../dk/schema";
import { diffGames, normalizeGame, normalizeGames, sideKey, sortGames, withSource, type GamesDiff } from "./normalize";
import { DkStore } from "./store";
import type { Game, Move, Price } from "./types";

export type BoardChange =
  | { type: "snapshot"; games: Game[] }
  | { type: "update"; games: Game[]; removed: string[]; moves: Move[] };

export interface EngineOptions {
  /** Full board from DraftKings' REST endpoint. */
  fetchSnapshot(onIssue: ParseIssue): Promise<DkSnapshot>;
  /** Called once per change to the board. */
  onChange(change: BoardChange, meta: DkUpdateMeta | null, receivedAt: number): void;
  now(): number;
  /** Timestamps for moves that have no DK time (REST corrections). */
  toIso?(t: number): string;
  onParseIssue?: ParseIssue;
  /** Deltas this recent are replayed onto a new snapshot. */
  replayWindowMs?: number;
  /** Min gap between resyncs triggered by updates we couldn't place. */
  unresolvedResyncMs?: number;
}

/**
 * The board: DraftKings' REST snapshot plus push-feed deltas, normalized to
 * game/market/side/line/odds, with each side's previous price.
 *
 * Runs in two places: in the browser, which loads the snapshot directly from
 * DraftKings (DK blocks cloud IPs from that endpoint, not browsers), and on
 * the server when it can reach the endpoint (local dev, for /api/odds and
 * ClickHouse). Deltas come from the server's push-feed connection either way.
 */
export class BoardEngine {
  hasData = false;
  lastSnapshotAt: number | null = null;
  snapshotError: string | null = null;
  snapshotFailures = 0;
  lastSnapshotAttemptAt = 0;
  readonly counters = { moves: 0, resyncs: 0, resyncCorrections: 0, unresolved: 0 };

  private store = new DkStore();
  /** Normalized board, without prev/changedAt decoration. Diffed on every change. */
  private board = new Map<string, Game>();
  private history = new Map<string, { prev: Price; changedAt: string }>();
  private recent: { at: number; delta: DkDelta }[] = [];
  private resyncBuffer: DkDelta[] | null = null;
  private resyncPromise: Promise<boolean> | null = null;
  private lastUnresolvedResyncAt = 0;
  private readonly replayWindowMs: number;
  private readonly unresolvedResyncMs: number;

  constructor(private readonly opts: EngineOptions) {
    this.replayWindowMs = opts.replayWindowMs ?? 10_000;
    this.unresolvedResyncMs = opts.unresolvedResyncMs ?? 10_000;
  }

  /**
   * Apply one push-feed update. Before the first snapshot it's only buffered,
   * then replayed onto the snapshot.
   */
  apply(delta: DkDelta, meta: DkUpdateMeta | null, receivedAt: number) {
    this.recent.push({ at: receivedAt, delta });
    while (this.recent.length && receivedAt - this.recent[0].at > this.replayWindowMs) this.recent.shift();
    this.resyncBuffer?.push(delta);
    if (!this.hasData) return;

    const result = this.store.apply(delta);
    if (result.unresolved.length) {
      this.counters.unresolved += result.unresolved.length;
      if (receivedAt - this.lastUnresolvedResyncAt >= this.unresolvedResyncMs) {
        this.lastUnresolvedResyncAt = receivedAt;
        void this.resync();
      }
    }
    if (result.touched.size) this.recompute("ws", meta, receivedAt, result.touched);
  }

  /**
   * Fetch a full snapshot and swap it in. Concurrent calls share one request.
   * Deltas from the replay window and those arriving during the request are
   * replayed on top, in order: every DK change is "set this field", so the
   * result ends at the latest value for anything they touched.
   */
  resync(): Promise<boolean> {
    if (this.resyncPromise) return this.resyncPromise;
    const startedAt = this.opts.now();
    this.lastSnapshotAttemptAt = startedAt;
    this.resyncBuffer = this.recent.filter((r) => startedAt - r.at <= this.replayWindowMs).map((r) => r.delta);
    this.resyncPromise = (async () => {
      try {
        const snapshot = await this.opts.fetchSnapshot(this.opts.onParseIssue ?? (() => {}));
        const fresh = DkStore.fromSnapshot(snapshot);
        for (const delta of this.resyncBuffer ?? []) fresh.apply(delta);
        this.store = fresh;
        const at = this.opts.now();
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
      }
    })();
    return this.resyncPromise;
  }

  games(): Game[] {
    return sortGames([...this.board.values()].map((g) => this.decorate(g)));
  }

  gameMap(): Map<string, Game> {
    return this.board;
  }

  private recompute(source: "ws" | "resync" | "snapshot", meta: DkUpdateMeta | null, receivedAt: number, touched?: Set<string>) {
    let diff: GamesDiff;
    if (touched) {
      // Push update: rebuild and compare only the games it touched.
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

    if (source === "snapshot") {
      this.hasData = true;
      this.opts.onChange({ type: "snapshot", games: this.games() }, null, receivedAt);
      return;
    }

    const moves = withSource(diff.moves, source === "ws" ? "ws" : "resync");
    const changedAt = meta?.createdTime ?? (this.opts.toIso ?? ((t: number) => new Date(t).toISOString()))(receivedAt);
    for (const m of moves) this.history.set(sideKey(m.gameId, m.market, m.side), { prev: m.from, changedAt });
    for (const id of diff.removed) {
      for (const key of this.history.keys()) if (key.startsWith(`${id}:`)) this.history.delete(key);
    }
    if (source === "ws") this.counters.moves += moves.length;
    else this.counters.resyncCorrections += moves.length;

    if (diff.changed.length || diff.removed.length) {
      this.opts.onChange(
        { type: "update", games: diff.changed.map((id) => this.decorate(this.board.get(id)!)), removed: diff.removed, moves },
        meta,
        receivedAt,
      );
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
}
