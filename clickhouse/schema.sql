-- Every price we observe, one row per side. `source` is:
--   snapshot: the full board when a server instance starts (baseline)
--   ws:       a move pushed by DraftKings' live feed
--   resync:   a move found by the periodic full REST check (i.e. a delta we missed)
-- Several server instances can record the same DraftKings move; ReplacingMergeTree
-- collapses duplicates on (game, market, side, dk_created_at, selection). Query with FINAL.
-- The app runs these statements itself on first write (src/lib/clickhouse.ts); keep them in sync.
CREATE TABLE IF NOT EXISTS odds_ticks (
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
ORDER BY (game_id, market, side, dk_created_at, selection_id);

-- Line history: every price change DraftKings' push feed sends, recorded on any
-- host (it needs no server-side board). `prev_*` is the price before, when known;
-- `prev_source` says where it came from:
--   feed:   seen earlier on the same push-feed connection
--   board:  the server's own board
--   viewer: the board a viewer's browser loaded from DraftKings
-- Several instances can record the same change; ReplacingMergeTree keeps one,
-- preferring a row that knows the previous price (has_prev = 1). Query with FINAL.
CREATE TABLE IF NOT EXISTS price_changes (
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
ORDER BY (market_id, selection_id, dk_created_at);

-- One row per push-feed update, for latency percentiles over time.
CREATE TABLE IF NOT EXISTS feed_latency (
    dk_created_at DateTime64(3, 'UTC'),
    dk_published_at Nullable(DateTime64(3, 'UTC')),
    ws_published_at Nullable(DateTime64(3, 'UTC')),
    server_received_at DateTime64(3, 'UTC'),
    instance_id LowCardinality(String)
) ENGINE = MergeTree
ORDER BY server_received_at
TTL toDateTime(server_received_at) + INTERVAL 30 DAY;
