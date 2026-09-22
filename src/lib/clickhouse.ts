import type { ClickHouseClient } from "@clickhouse/client";
import type { DkUpdateMeta } from "./dk/schema";
import type { Game, Move } from "./odds/types";

/** Where every price we see gets recorded for Grafana. Optional: the app runs without it. */
export interface TickSink {
  readonly enabled: boolean;
  /** Full board as of a snapshot: the baseline that moves are measured against. */
  recordBoard(games: Iterable<Game>, observedAt: number): void;
  recordMoves(moves: Move[], games: Map<string, Game>, meta: DkUpdateMeta | null, receivedAt: number): void;
  recordLatency(meta: DkUpdateMeta, receivedAt: number, instanceId: string): void;
  status(): { enabled: boolean; lastError: string | null; written: number };
}

export const noopSink: TickSink = {
  enabled: false,
  recordBoard() {},
  recordMoves() {},
  recordLatency() {},
  status: () => ({ enabled: false, lastError: null, written: 0 }),
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

class ClickHouseSink implements TickSink {
  readonly enabled = true;
  private ticks: Record<string, unknown>[] = [];
  private latency: Record<string, unknown>[] = [];
  private flushing = false;
  private ready: Promise<void> | null = null;
  private lastError: string | null = null;
  private written = 0;
  private timer: ReturnType<typeof setInterval>;
  private client: Promise<ClickHouseClient> | null = null;

  constructor(private readonly connect: () => Promise<ClickHouseClient>) {
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref?.();
  }

  recordBoard(games: Iterable<Game>, observedAt: number) {
    const at = chTime(observedAt);
    for (const g of games) {
      for (const m of Object.values(g.markets)) {
        for (const s of m!.selections) {
          this.ticks.push(this.row(g, m!.type, s.side, s.id, s, null, "snapshot", at, at));
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
      if (g) this.ticks.push(this.row(g, mv.market, mv.side, mv.selectionId, mv.to, mv.from, mv.source, created, received));
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

  /** If ClickHouse is down, don't let the buffer grow without bound. */
  private cap() {
    if (this.ticks.length > 20_000) this.ticks.splice(0, this.ticks.length - 20_000);
    if (this.latency.length > 20_000) this.latency.splice(0, this.latency.length - 20_000);
  }

  private async flush() {
    if (this.flushing || (this.ticks.length === 0 && this.latency.length === 0)) return;
    this.flushing = true;
    const ticks = this.ticks.splice(0);
    const latency = this.latency.splice(0);
    try {
      const client = await (this.client ??= this.connect());
      this.ready ??= this.migrate(client);
      await this.ready;
      if (ticks.length) await client.insert({ table: "odds_ticks", values: ticks, format: "JSONEachRow" });
      if (latency.length) await client.insert({ table: "feed_latency", values: latency, format: "JSONEachRow" });
      this.written += ticks.length + latency.length;
      this.lastError = null;
    } catch (err) {
      this.client = null;
      this.ready = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      // Put the rows back for the next attempt; cap() bounds memory.
      this.ticks.unshift(...ticks);
      this.latency.unshift(...latency);
      this.cap();
    } finally {
      this.flushing = false;
    }
  }

  private async migrate(client: ClickHouseClient) {
    for (const sql of SCHEMA) await client.command({ query: sql });
  }
}

/**
 * Off unless CLICKHOUSE_URL is set. The client library is only loaded when it
 * is, so deployments without ClickHouse (like the live site) don't pay for it
 * on every cold start.
 */
export function createSinkFromEnv(): TickSink {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) return noopSink;
  return new ClickHouseSink(async () => {
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
