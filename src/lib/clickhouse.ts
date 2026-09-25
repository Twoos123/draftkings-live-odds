import type { ClickHouseClient } from "@clickhouse/client";
import type { ObservedChange } from "./dk/prices";
import type { DkUpdateMeta } from "./dk/schema";
import { allMarkets } from "./odds/normalize";
import type { FromSource, Game, MarketType, Move, Period, RecordedChange } from "./odds/types";

/**
 * odds_ticks.market: "moneyline" for the full game (as it always was, so
 * existing queries keep meaning the full game), "half_moneyline" for the 1st half.
 */
export function tickMarket(period: Period, type: MarketType): string {
  return period === "full" ? type : `${period}_${type}`;
}

/** Where every price we see gets recorded, for Grafana and line history. Optional: the app runs without it. */
export interface TickSink {
  readonly enabled: boolean;
  /** Full board as of a snapshot: the baseline that moves are measured against. */
  recordBoard(games: Iterable<Game>, observedAt: number): void;
  recordMoves(moves: Move[], games: Map<string, Game>, meta: DkUpdateMeta | null, receivedAt: number): void;
  /** Price changes straight from the push feed. Needs no server-side board, so it works on Vercel. */
  recordChanges(changes: ObservedChange[], meta: DkUpdateMeta, receivedAt: number): void;
  recordLatency(meta: DkUpdateMeta, receivedAt: number, instanceId: string): void;
  status(): { enabled: boolean; lastError: string | null; written: number };
}

export const noopSink: TickSink = {
  enabled: false,
  recordBoard() {},
  recordMoves() {},
  recordChanges() {},
  recordLatency() {},
  status: () => ({ enabled: false, lastError: null, written: 0 }),
};

/** Line history, read back for /api/history. */
export interface PriceHistory {
  readonly enabled: boolean;
  /**
   * Recorded changes for these markets, oldest first. `movesOnly` skips
   * changes whose previous price isn't known. At most `limit`, keeping the newest.
   */
  forMarkets(marketIds: string[], opts: { movesOnly: boolean; limit: number }): Promise<RecordedChange[]>;
}

export const noHistory: PriceHistory = {
  enabled: false,
  forMarkets: async () => [],
};

// Kept in sync with clickhouse/schema.sql; created on first use so a fresh
// ClickHouse Cloud service works without a manual migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS odds_ticks (
    game_id String,
    game String,
    start_time DateTime64(3, 'UTC'),
    market LowCardinality(String),
    side LowCardinality(String),
    selection_id String,
    line Nullable(Float64),
    american Int32,
    decimal Float64,
    prev_line Nullable(Float64),
    prev_american Nullable(Int32),
    source LowCardinality(String),
    dk_created_at DateTime64(3, 'UTC'),
    server_received_at DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree
  ORDER BY (game_id, market, side, dk_created_at, selection_id)`,
  `CREATE TABLE IF NOT EXISTS price_changes (
    market_id String,
    selection_id String,
    label String,
    line Nullable(Float64),
    american Int32,
    decimal Float64,
    prev_line Nullable(Float64),
    prev_american Nullable(Int32),
    prev_decimal Nullable(Float64),
    prev_source LowCardinality(String),
    has_prev UInt8,
    dk_created_at DateTime64(3, 'UTC'),
    server_received_at DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(has_prev)
  ORDER BY (market_id, selection_id, dk_created_at)`,
  `CREATE TABLE IF NOT EXISTS feed_latency (
    dk_created_at DateTime64(3, 'UTC'),
    dk_published_at Nullable(DateTime64(3, 'UTC')),
    ws_published_at Nullable(DateTime64(3, 'UTC')),
    server_received_at DateTime64(3, 'UTC'),
    instance_id LowCardinality(String)
  ) ENGINE = MergeTree
  ORDER BY server_received_at
  TTL toDateTime(server_received_at) + INTERVAL 30 DAY`,
];

/** ClickHouse DateTime64 accepts "YYYY-MM-DD hh:mm:ss.sss". */
function chTime(input: string | number): string {
  return new Date(input).toISOString().replace("T", " ").replace("Z", "");
}

/** …and returns it in the same form, in UTC. */
function fromChTime(value: string): string {
  return new Date(`${value.replace(" ", "T")}Z`).toISOString();
}

/** A lazily created client, with the tables created before first use. */
class Connection {
  private client: Promise<ClickHouseClient> | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly connect: () => Promise<ClickHouseClient>) {}

  async get(): Promise<ClickHouseClient> {
    try {
      const client = await (this.client ??= this.connect());
      await (this.ready ??= (async () => {
        for (const sql of SCHEMA) await client.command({ query: sql });
      })());
      return client;
    } catch (err) {
      this.reset();
      throw err;
    }
  }

  reset() {
    this.client = null;
    this.ready = null;
  }
}

class ClickHouseSink implements TickSink {
  readonly enabled = true;
  private ticks: Record<string, unknown>[] = [];
  private changes: Record<string, unknown>[] = [];
  private latency: Record<string, unknown>[] = [];
  private flushing = false;
  private lastError: string | null = null;
  private written = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly db: Connection) {
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref?.();
  }

  recordBoard(games: Iterable<Game>, observedAt: number) {
    const at = chTime(observedAt);
    for (const g of games) {
      for (const m of allMarkets(g)) {
        for (const s of m.selections) {
          this.ticks.push(this.row(g, tickMarket(m.period, m.type), s.side, s.id, s, null, "snapshot", at, at));
        }
      }
    }
    this.cap();
  }

  recordMoves(moves: Move[], games: Map<string, Game>, meta: DkUpdateMeta | null, receivedAt: number) {
    const received = chTime(receivedAt);
    const created = meta?.createdTime ? chTime(meta.createdTime) : received;
    for (const mv of moves) {
      const g = games.get(mv.gameId);
      if (g) this.ticks.push(this.row(g, tickMarket(mv.period, mv.market), mv.side, mv.selectionId, mv.to, mv.from, mv.source, created, received));
    }
    this.cap();
  }

  recordChanges(changes: ObservedChange[], meta: DkUpdateMeta, receivedAt: number) {
    const received = chTime(receivedAt);
    const created = meta.createdTime ? chTime(meta.createdTime) : received;
    for (const c of changes) {
      this.changes.push({
        market_id: c.marketId,
        selection_id: c.selectionId,
        label: c.label,
        line: c.to.line,
        american: c.to.american,
        decimal: c.to.decimal,
        prev_line: c.from?.line ?? null,
        prev_american: c.from?.american ?? null,
        prev_decimal: c.from?.decimal ?? null,
        prev_source: c.fromSource ?? "",
        has_prev: c.from ? 1 : 0,
        dk_created_at: created,
        server_received_at: received,
      });
    }
    this.cap();
  }

  recordLatency(meta: DkUpdateMeta, receivedAt: number, instanceId: string) {
    if (!meta.createdTime) return;
    this.latency.push({
      dk_created_at: chTime(meta.createdTime),
      dk_published_at: meta.publishedTime ? chTime(meta.publishedTime) : null,
      ws_published_at: meta.wsPublishedTime ? chTime(meta.wsPublishedTime) : null,
      server_received_at: chTime(receivedAt),
      instance_id: instanceId,
    });
    this.cap();
  }

  status() {
    return { enabled: true, lastError: this.lastError, written: this.written };
  }

  private row(g: Game, market: string, side: string, selectionId: string, p: Move["to"], prev: Move["from"] | null, source: string, created: string, received: string) {
    return {
      game_id: g.id,
      game: g.name,
      start_time: chTime(g.startTime),
      market,
      side,
      selection_id: selectionId,
      line: p.line,
      american: p.american,
      decimal: p.decimal,
      prev_line: prev?.line ?? null,
      prev_american: prev?.american ?? null,
      source,
      dk_created_at: created,
      server_received_at: received,
    };
  }

  /** If ClickHouse is down, don't let the buffers grow without bound. */
  private cap() {
    for (const rows of [this.ticks, this.changes, this.latency]) {
      if (rows.length > 20_000) rows.splice(0, rows.length - 20_000);
    }
  }

  private async flush() {
    if (this.flushing || (this.ticks.length === 0 && this.changes.length === 0 && this.latency.length === 0)) return;
    this.flushing = true;
    const ticks = this.ticks.splice(0);
    const changes = this.changes.splice(0);
    const latency = this.latency.splice(0);
    try {
      const client = await this.db.get();
      if (ticks.length) await client.insert({ table: "odds_ticks", values: ticks, format: "JSONEachRow" });
      if (changes.length) await client.insert({ table: "price_changes", values: changes, format: "JSONEachRow" });
      if (latency.length) await client.insert({ table: "feed_latency", values: latency, format: "JSONEachRow" });
      this.written += ticks.length + changes.length + latency.length;
      this.lastError = null;
    } catch (err) {
      this.db.reset();
      this.lastError = err instanceof Error ? err.message : String(err);
      // Put the rows back for the next attempt; cap() bounds memory. A retry
      // after a partial failure may insert some rows twice; odds_ticks and
      // price_changes collapse duplicates, and feed_latency is only percentiles.
      this.ticks.unshift(...ticks);
      this.changes.unshift(...changes);
      this.latency.unshift(...latency);
      this.cap();
    } finally {
      this.flushing = false;
    }
  }
}

interface ChangeRow {
  market_id: string;
  selection_id: string;
  label: string;
  line: number | null;
  american: number;
  decimal: number;
  prev_line: number | null;
  prev_american: number | null;
  prev_decimal: number | null;
  prev_source: string;
  dk_created_at: string;
}

class ClickHouseHistory implements PriceHistory {
  readonly enabled = true;

  constructor(private readonly db: Connection) {}

  async forMarkets(marketIds: string[], { movesOnly, limit }: { movesOnly: boolean; limit: number }): Promise<RecordedChange[]> {
    if (marketIds.length === 0) return [];
    const client = await this.db.get();
    // FINAL: several server instances may have recorded the same change.
    const result = await client.query({
      query: `
        SELECT market_id, selection_id, label, line, american, decimal,
               prev_line, prev_american, prev_decimal, prev_source, dk_created_at
        FROM price_changes FINAL
        WHERE market_id IN {markets: Array(String)} ${movesOnly ? "AND has_prev = 1" : ""}
        ORDER BY dk_created_at DESC
        LIMIT {limit: UInt32}`,
      query_params: { markets: marketIds, limit },
      format: "JSONEachRow",
    });
    const rows = await result.json<ChangeRow>();
    return rows.reverse().map((r) => ({
      marketId: r.market_id,
      selectionId: r.selection_id,
      label: r.label,
      to: { line: r.line, american: r.american, decimal: r.decimal },
      from: r.prev_american === null || r.prev_decimal === null ? null : { line: r.prev_line, american: r.prev_american, decimal: r.prev_decimal },
      fromSource: (r.prev_source || null) as FromSource | null,
      at: fromChTime(r.dk_created_at),
    }));
  }
}

/**
 * Off unless CLICKHOUSE_URL is set. The client library is only loaded when it
 * is, so deployments without ClickHouse don't pay for it on every cold start.
 */
function connectionFromEnv(): Connection | null {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) return null;
  return new Connection(async () => {
    const { createClient } = await import("@clickhouse/client");
    return createClient({
      url,
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: process.env.CLICKHOUSE_DATABASE ?? "default",
      request_timeout: 10_000,
    });
  });
}

export function createSinkFromEnv(): TickSink {
  const db = connectionFromEnv();
  return db ? new ClickHouseSink(db) : noopSink;
}

export function createHistoryFromEnv(): PriceHistory {
  const db = connectionFromEnv();
  return db ? new ClickHouseHistory(db) : noHistory;
}
