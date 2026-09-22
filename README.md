# DraftKings NFL Live Odds

Live NFL moneyline, spread and total odds from DraftKings, on a page that updates itself as lines move.

- **Live:** _add your Vercel URL here_
- **Freshness:** a line move usually reaches our server **about 0.17 s after DraftKings creates it** (median, NFL), and your screen a few tens of ms later. Occasionally DraftKings itself holds a change for 1–2 s before publishing it; that's the p95 of ~1.6 s. [Details below](#how-fresh-are-the-odds).
- **Nothing missed:** in a 20-minute audit, the push feed delivered all 26 NFL price changes DraftKings made (0 missed). [How that was checked](#does-the-live-feed-miss-anything).

![Screenshot](docs/screenshot.png)

## How it works

```
DraftKings                                    Vercel · Next.js (Node)                        Browser
──────────                                    ───────────────────────                        ───────
WebSocket push feed ── deltas, as they happen ──►  OddsHub (one per server instance)
  wss://sportsbook-ws-us-nj…/websocket               ├─ DkStore: apply add / change / remove
                                                     ├─ normalize → game · market · side · line · odds
REST snapshot ── on connect, every 60s, on Refresh ─►├─ diff → moves (previous price, DK timestamps)
  sportsbook-nash…/leagueSubcategory/v1/markets      ├─ ClickHouse writer (optional) ──► Grafana
                                                     └─ fan-out ── Server-Sent Events ──► odds table
                                                                   /api/stream
```

1. **Subscribe first.** The server opens DraftKings' own push feed, the same WebSocket sportsbook.draftkings.com uses, and subscribes to NFL "Game Lines" (moneyline, spread, total).
2. **Then snapshot.** Once DraftKings acknowledges the subscription, the server fetches the full board from DraftKings' REST endpoint. Any deltas that arrived while that request was in flight are replayed on top. Every DK change is a "set this field" operation, so replaying one is safe.
3. **Apply deltas.** Each push message is applied to an in-memory copy of DraftKings' entities. The board is re-normalized and diffed against the previous version. Changed games go to every connected browser within milliseconds.
4. **Keep it honest.** Every 60 seconds the server re-fetches the full snapshot and compares. Any price that differs from what the deltas produced is corrected, broadcast, and counted as a "resync correction". If the delta handling is right, that counter stays at 0, so it doubles as a live correctness check.
5. **Browser.** The page receives a `snapshot` on connect, then `update`s:
   - Moved prices flash green or red, with the old price crossed out beside the new one for 10 minutes.
   - A **Latest line moves** panel lists recent changes; click one to jump to the game.
   - A sticky toolbar holds the live status, a "≈0.2 s behind DraftKings" latency badge, team search, American/decimal odds and Refresh.
   - A collapsible **How to read these odds** explains spreads, totals and moneylines.
   - Hovering a price shows its implied win probability.
   - When data can't be trusted, it says so.

### Why this approach

The brief says the *how* is the main thing being evaluated. These are the options considered:

| Option | Latency | Verdict |
|---|---|---|
| Scrape the rendered page with a headless browser | seconds | Rejected. Heavy (a browser per server), slow, fragile to layout changes, and a headless browser is exactly what DraftKings' bot protection is built to catch. |
| Poll the REST snapshot endpoint | = poll interval | Too slow on its own: polling every second means about 86k requests a day to DraftKings. **Used as the fallback** when the push feed is down (every 10 s) and as the 60 s integrity check. |
| **Subscribe to DraftKings' push feed** | **~60 ms after DK publishes** | **Chosen.** It's what DraftKings' own site does. DK pushes only what changed, the moment it changes, over one connection, with no login or token. |
| Browser connects to DraftKings directly | lowest | Rejected. Every viewer becomes a DraftKings connection, there's no server-side normalization or history (ClickHouse), and it depends on DK accepting a foreign origin. |

**Server-Sent Events** carry updates to the browser rather than a WebSocket, because traffic only flows one way. SSE also works as a normal streaming HTTP response from a Vercel Function, and `EventSource` reconnects on its own.

**Running on Vercel (no always-on server).** Functions on the Hobby plan can run for at most 300 s. So:
- Each browser stream ends after ~280 s and the browser reconnects immediately. The page keeps its data meanwhile, so nothing flickers.
- With Fluid compute, concurrent requests share a warm instance. The hub lives in module scope, so **one DraftKings connection serves every viewer on that instance** rather than one per viewer.
- The hub connects on the first viewer and disconnects 60 s after the last one leaves.
- If Vercel paused the instance between requests (the hub's 1 s timer stopped firing), the next viewer triggers a reconnect and a fresh snapshot before trusting the data.
- Trade-off: when nobody has the page open, nothing is watching DraftKings, so ClickHouse only records moves while someone is watching. An always-on worker (see [Scaling](#adding-a-second-sportsbook-or-league)) would remove that gap.

## How fresh are the odds

Every push message carries DraftKings' own timestamps (`createdTime`, `publishedTime`, and the socket server's `websocketPublishTimestamp`). The server stamps when it received each message.

**Measuring on DraftKings' clock.** One-way latency is only as good as the clocks involved. The PC this was built on turned out to have no time sync at all ("Local CMOS Clock") and ran about 0.35 s behind DraftKings. That produced negative latencies until it was corrected:
1. When DraftKings acknowledges our subscription, its reply carries its own timestamp. Timing that round trip NTP-style gives the offset between our clock and DK's, to within about ±20 ms.
2. As a safety net, a message can never arrive before DK sent it, so any negative wire time nudges the offset up.
3. Every timestamp the server emits is then on DraftKings' clock, and `/api/time` serves DK-aligned time so the browser lines up too.

This makes the numbers correct on any host. On Vercel, whose clocks are synced, the offset is close to 0.

Measured with that correction over 35 NFL push updates (Toronto, recorded in ClickHouse):

| Stage | Median | p95 |
|---|---|---|
| DraftKings creates the change → DraftKings publishes it | 20 ms | 1.4 s |
| DraftKings' socket server → our server (network) | 29 ms | 40 ms |
| DraftKings publishes → our server has it | 58 ms | — |
| **DraftKings creates the change → our server has it** | **174 ms** | **1.6 s** |
| Our server → your browser | tens of ms | — |

So **the number on screen is typically about 0.2 s behind DraftKings' trading system.** The long tail is inside DraftKings: now and then they hold a change for 1–2 s before pushing it. Busier traffic can make that internal step slower; a 30-minute recording dominated by live MLB games had a median of ~0.4 s. None of that can be reduced from outside. The page shows its live numbers under **Feed details**, `/api/health` has the server-side percentiles, and Grafana charts them over time.

When things go wrong, the page says how old the numbers are instead of pretending:

| Situation | Freshness | What the page shows |
|---|---|---|
| Normal | ~0.2 s | **Live** |
| Push feed dropped | ≤ 10 s (REST polling while it reconnects with backoff) | **Delayed** + explanation |
| Push feed up, REST checks failing | live (deltas still flowing) | **Live** + warning |
| DraftKings unreachable | frozen | **Stale**: "last confirmed 4m ago", greyed-out odds, error reason |
| Our server unreachable | frozen | **Reconnecting**, then greyed out after 15 s of silence |

There's also a **Refresh** button. It forces an immediate full re-check of every line with DraftKings.

## Does the live feed miss anything?

A delta feed is only useful if you get every delta. `npm run audit` checks this directly (`scripts/feed-audit.ts`):
- It builds a board from the push feed **alone** (never re-synced), using the app's own subscription, store and normalizer.
- Every 5 s it compares that board with a fresh REST snapshot.
- Any difference still there on the next poll counts as a missed update. The DK CDN cache is 1 s and a push can be in flight, so one poll of disagreement is allowed.

**Result (20 minutes, 239 comparisons):**
- DraftKings made **26 NFL price changes** across 13 moves, including a spread moving off 3 to 2.5, which exercises the new-selection-id path.
- The push feed delivered **all 26. Missed: 0.**
- In 11 of the 13 moves the push board already had the new price when REST first showed it. In the other 2, REST showed it first, because DraftKings held the push for ~2 s. So push isn't *always* DK's fastest path, but it never lost anything.

The server also runs the same check continuously: the 60 s resync counts **resync corrections**, which stayed at 0 over the same period. It's shown in **Feed details** and in Grafana.

## Performance: where the milliseconds go

| Stage | Median | Ours to change? |
|---|---|---|
| Inside DraftKings (created → published) | 20 ms (p95 1.4 s) | No |
| DraftKings → Akamai edge → our server | ~30 ms | Barely. The feed is proxied by Akamai's edge network (`…edgesuite.net`), so moving our server only changes the last short hop. |
| **Our code:** raw frame → parse → validate → apply → rebuild game → diff → SSE bytes | **26 µs** (p99 78 µs) | Yes. See below. |
| Our server → browser | tens of ms | Only by removing the hop |

Our processing is about 0.02% of the total, so **rewriting it in Go, moving to Python, or adding multiprocessing wouldn't make the page any fresher**:
- **Go** might save ~20 µs.
- **Python** would be slower.
- **Multiprocessing or threads** would add inter-process hops that cost more than the work itself. There's one socket delivering roughly one message a second, so there's nothing to parallelize.

What mattered was keeping the per-update work proportional to *what changed*, not to the size of the board. `test/perf.test.ts` measures this and fails if it regresses past 1 ms:

- **Only the touched game is rebuilt.** The store keeps parent → child indexes (event → markets → selections), so an update rebuilds and diffs one game instead of all 32. That took per-update cost from 335 µs to 26 µs, and it stays flat as leagues are added.
- **Each SSE message is serialized once** and the same bytes go to every viewer on the instance, instead of `JSON.stringify` per viewer.
- **In the browser**, unchanged games keep their object identity and each game card is memoized, so an update re-renders one card, not 192 price cells. Only cells that recently moved run a timer, and it fires at the two moments that matter (flash ends, old price is dropped) rather than every second.

## Getting the data: what we found

Found with the browser's Network tab on sportsbook.draftkings.com/leagues/football/nfl:

- **REST snapshot:** `GET https://sportsbook-nash.draftkings.com/sites/US-NJ-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets` with OData-style filters for league `88808` (NFL) and subcategory `4518` (Game Lines). It returns the whole board: 32 games, 96 markets, 192 selections. It's CDN-cached for 1 s.
- **Push feed:** `wss://sportsbook-ws-us-nj.draftkings.com/websocket?format=json`, JSON-RPC `subscribe` with the same filters.
  - The site itself uses `format=msgpack` (binary). `format=json` returns the same messages as JSON.
  - Messages arrive ~60 ms after DraftKings publishes them (29 ms of that is the network hop from their socket server).

### Shape of the data: a delta feed

DraftKings models the board relationally: flat lists of `events`, `markets` and `selections` that reference each other by id. The push feed **only sends what changed** and expects the client to keep the rest:

```jsonc
{ "event": "update",
  "data": {
    "data": { "add":    { "events": [], "markets": [], "selections": [] },
              "change": { "events": [], "markets": [ { "id": "3_84695445", "isSuspended": false } ], "selections": [] },
              "remove": { "events": [], "markets": [], "selections": [] } },
    "metadata": { "createdTime": "…", "publishedTime": "…" } },
  "websocketPublishTimestamp": "…" }
```

Details that matter (all covered by tests in `test/`, using real captured messages):

- **`change` objects are partial.** A market change carries `isSuspended` but no `eventId`, so changes are merged onto what we already have.
- **A line move gets a new selection id.** Ids encode the line (`0OU84695613O4450_1` is Over 44.5). When a total moves to 45.5, DraftKings sends a selection with a new id, `replacedSelectionId` pointing at the old one, and **no `marketId`**. Updating "by id" would silently lose every line move. The store carries the old selection's fields over to the new id.
- Line moves can also arrive as an `add` plus a `remove`.
- **Negative odds use a Unicode minus** (`−110`, U+2212), which `Number()` can't parse.
- **Markets get suspended** (`isSuspended`) around news or kickoff. They're shown greyed out with a lock.
- **Anything unexpected:** each entity is validated on its own (zod) and bad records are dropped and counted, never fatal. A change that references something unknown triggers a REST resync (rate-limited) instead of guessing.

This is mapped to a clean shape (`src/lib/odds/types.ts`): **game → market (moneyline / spread / total) → side (away/home, over/under) → line + odds**, with the previous price and the time of the last move.

## Auth, cookies, bot protection, geo

- **No login, cookie or token is used anywhere.** The push feed needs none: DraftKings' own client sends `jwt: "default-token"` for anonymous users, and the server accepts subscriptions without it. **Nothing can expire.** If DraftKings ever starts requiring a token, the subscription won't be acknowledged within 10 s. The page then reports the feed as down and falls back to REST polling.
- **Bot protection (Akamai)** sits in front of the REST endpoint and the website. From `curl` and Python's default HTTP client it returns `403 Access Denied`, even with a browser User-Agent. During investigation, the identical request made with a browser-like TLS handshake succeeded, which showed the block is on the TLS fingerprint rather than headers or cookies. **Node's built-in `fetch` is accepted as-is**, so the app sends a plain request with default headers: no impersonation, no cookies, nothing to maintain. A headless browser was also blocked (it announces itself as `HeadlessChrome`), which is another reason not to scrape.
  - *Risk:* Akamai could start rejecting Node or Vercel's IP ranges. The app would then show **Offline/Stale** with "HTTP 403 (blocked by Akamai)" rather than failing silently.
- **Geo:** odds are readable without being in a legal betting state (tested from Ontario). The app uses the New Jersey board. Ontario works too (`DK_REST_SITE=CA-ON-SB`, `DK_WS_SITE=dkcaon`, `DK_WS_HOST=sportsbook-ws-ca-on.draftkings.com`).
- **Rate limits:** none hit. The app's footprint is one WebSocket plus one REST request per minute per active server instance (every 10 s while the push feed is down, with backoff on errors).

## Reliability

- Push feed: reconnects with exponential backoff and jitter (0.5 s → 30 s). A ping every 15 s detects a dead socket, and a subscription that isn't acknowledged within 10 s is abandoned.
- REST: 8 s timeout. Failures back off up to 60 s, and the last good board stays up with a stale warning.
- Snapshot/delta race: deltas from 5 s before and during a snapshot request are replayed onto it.
- Unknown references trigger a resync, at most once per 10 s.
- Browser: `EventSource` auto-reconnects. A watchdog reconnects after 15 s without a heartbeat (status events arrive every 5 s). The stream closes after a minute in a background tab and reopens on return.
- ClickHouse is optional and isolated: writes are batched every 2 s, a failure keeps the rows (capped) and retries, and it never blocks the odds.

## Running locally

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 29 tests, using real captured DraftKings data
npm run typecheck
npm run audit        # 15-min check that the push feed misses nothing (see above)
```

No configuration is needed. See `.env.example` for the optional settings.

To see the move highlight without waiting for DraftKings, run `curl -X POST localhost:3000/api/dev/simulate` (development only; 404 in production). It nudges a random moneyline through the same code path as a real update. The next 60 s REST check will correct it back and count it as a resync correction, which is the self-healing working.

### ClickHouse + Grafana (optional)

```bash
docker compose up -d
# then in .env.local:
#   CLICKHOUSE_URL=http://localhost:8123
#   CLICKHOUSE_PASSWORD=odds
npm run dev
```

Grafana runs at http://localhost:3001. It opens read-only with no login; use admin / admin to edit. The **DraftKings NFL live odds** dashboard shows:
- latency percentiles over time
- moves per market
- moneyline history per game
- missed moves caught by the REST check
- a table of recent moves

![Grafana dashboard](docs/grafana.png)

- `odds_ticks` stores every observed price (`snapshot` baseline, `ws` moves, `resync` corrections) with DraftKings' timestamp and ours. It's a `ReplacingMergeTree`, so several instances recording the same move collapse to one row.
- `feed_latency` stores one row per push message.
- The app creates both tables on first write. `clickhouse/schema.sql` has the same DDL.

For the hosted version, point the same variables at a ClickHouse Cloud service and import `grafana/dashboards/odds.json` into Grafana Cloud.

### API

| Route | What |
|---|---|
| `GET /api/stream` | SSE: `snapshot`, `update`, `status` events. `?resync=1` forces a REST check first. |
| `GET /api/odds` | Current board as JSON (≤ 5 s old). `?fresh=1` forces a re-fetch. |
| `GET /api/health` | Feed status: connection state, last update and check times, latency percentiles, counters. |

## Deploying

Import the repo in Vercel; no settings are needed. Functions run in `iad1` (Washington, D.C.) by default, close to DraftKings' New Jersey servers. ClickHouse is off unless `CLICKHOUSE_URL` is set.

## Project layout

```
src/lib/dk/          DraftKings-specific: endpoints, raw schemas, REST snapshot, WebSocket feed
src/lib/odds/        Book-agnostic: clean types, delta store, normalize + diff, formatting, freshness copy
src/lib/hub.ts       Orchestration: subscribe → snapshot → deltas → fan-out, health, fallbacks
src/lib/clickhouse.ts Optional tick/latency writer
src/app/api/         stream (SSE), odds, health, time, dev/simulate
src/components/      Odds table, price cell, feed details
test/                Unit tests + real captured DraftKings fixtures
```

## Adding a second sportsbook or league

**A second league** is mostly configuration. League id `88808` and subcategory `4518` live in `src/lib/dk/config.ts`. Other leagues use the same endpoints with different ids, though soccer adds a draw side, so `Side` would gain one.

**A second sportsbook** needs a new adapter. Everything DraftKings-specific is in `src/lib/dk/`; everything below it (clean types, diffing, moves, SSE, UI, ClickHouse) doesn't know which book it's looking at. The changes:

1. Define a `BookAdapter` interface: `snapshot()`, `subscribe(onDelta)`, `normalize()`. Move today's DK code behind it.
2. Add a `book` field to games and ticks. Match the same game across books with a canonical id (league + teams + kickoff) instead of DK's event id.
3. Move ingestion out of the web tier. With several books and leagues you want **always-on workers** (one per book/league, e.g. on Fly.io or Railway) that write to ClickHouse and publish to a pub/sub channel (Redis). The Vercel app then just fans out. That also closes today's "only records while someone is watching" gap.

**Where AI and tooling help it scale:**
- **Finding and mapping feeds:** the slow part of adding a book is exactly what was done here by hand: watching the Network tab, finding the snapshot and push endpoints, and working out the delta semantics. An agent with a browser can capture a HAR from a book's site and propose the endpoints plus a draft adapter and schema. Captured traffic then becomes test fixtures, the way `test/fixtures/` works here.
- **Entity matching:** team and player names differ between books ("LA Chargers" vs "Los Angeles Chargers"). An LLM with a verified mapping table can handle the long tail, with humans approving new mappings.
- **Schema drift:** books change their payloads without notice. The per-record validation counters (`parseIssues`, `unresolved`, `resyncCorrections`) are the signal. Alert on them in Grafana, and let an agent diff new payloads against the fixtures and open a PR.
