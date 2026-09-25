import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DkSnapshot } from "@/lib/dk/schema";
import { BoardEngine, type BoardChange } from "@/lib/odds/engine";
import type { Game, Period } from "@/lib/odds/types";
import { deltaOf, loadBoardSnapshot, loadHalfSnapshot, loadSnapshot, loadWsFrames, odds, parseUpdate } from "./helpers";

// BoardEngine runs in the browser (and on the server where DK's REST board is reachable).

const GAME = "34118180";
const priceChange = (american: number) =>
  deltaOf((d) => d.change.selections.push({ id: "0ML84695613_3", displayOdds: odds(american, 1 + american / 100) }));
const meta = () => ({ createdTime: new Date(Date.now() - 80).toISOString(), publishedTime: null, wsPublishedTime: null });

function setup(fetchSnapshot?: () => Promise<DkSnapshot>, base = loadSnapshot()) {
  const fetch = vi.fn(fetchSnapshot ?? (async () => structuredClone(base)));
  const changes: BoardChange[] = [];
  const engine = new BoardEngine({ fetchSnapshot: fetch, onChange: (c) => changes.push(c), now: () => Date.now() });
  const last = <T extends BoardChange["type"]>(type: T) => changes.filter((c) => c.type === type).at(-1) as Extract<BoardChange, { type: T }>;
  return { engine, fetch, changes, last };
}

const awayMoneyline = (games: Game[], id = GAME, period: Period = "full") => games.find((g) => g.id === id)!.markets[period].moneyline!.selections[0];

beforeEach(() => vi.useRealTimers());

describe("BoardEngine", () => {
  it("loads the board, then turns deltas into moves with the previous price", async () => {
    const { engine, last } = setup();
    expect(await engine.resync()).toBe(true);
    expect(last("snapshot").games).toHaveLength(32);

    engine.apply(priceChange(250), meta(), Date.now());
    const update = last("update");
    expect(update.moves).toEqual([
      expect.objectContaining({ gameId: GAME, market: "moneyline", side: "away", source: "ws", from: expect.objectContaining({ american: 235 }), to: expect.objectContaining({ american: 250 }) }),
    ]);
    expect(awayMoneyline(update.games)).toMatchObject({ american: 250, prev: { american: 235 } });
    expect(engine.counters.moves).toBe(1);
  });

  it("buffers deltas that arrive before the board and replays them onto it", async () => {
    const { engine, changes, last } = setup();
    engine.apply(priceChange(260), meta(), Date.now()); // e.g. a replayed catch-up delta
    expect(changes).toEqual([]);
    await engine.resync();
    expect(awayMoneyline(last("snapshot").games).american).toBe(260);
  });

  it("replays updates that land while the snapshot request is in flight", async () => {
    const base = loadSnapshot();
    let release!: (s: DkSnapshot) => void;
    const { engine, last } = setup(() => new Promise((r) => (release = r)));
    const loading = engine.resync();
    engine.apply(priceChange(270), meta(), Date.now()); // newer than the snapshot that's coming back
    release(structuredClone(base));
    await loading;
    expect(awayMoneyline(last("snapshot").games).american).toBe(270);
    expect(engine.counters.resyncCorrections).toBe(0);
  });

  it("counts and emits drift that a later full check finds", async () => {
    const snap = loadSnapshot();
    const { engine, last } = setup(async () => structuredClone(snap));
    await engine.resync();
    snap.selections.find((s) => s.id === "0ML84695613_3")!.displayOdds = odds(300, 4); // a delta we never got
    await engine.resync();
    expect(last("update").moves).toEqual([expect.objectContaining({ source: "resync", to: expect.objectContaining({ american: 300 }) })]);
    expect(engine.counters.resyncCorrections).toBe(1);
  });

  it("reports a line move that DraftKings sends as removes, then adds, in separate updates", async () => {
    // Real frames: the TEN Titans @ NY Giants total went 40.5 -> 39.5. DK removed the old Over,
    // then the old Under, then added the new Over and Under, each in its own update, so for a
    // moment the game had no total at all.
    const { engine, changes } = setup();
    await engine.resync();
    for (const raw of loadWsFrames().filter((f) => f.includes("84695545"))) {
      const { delta, meta } = parseUpdate(raw);
      engine.apply(delta, meta, Date.now());
    }
    const moves = changes.flatMap((c) => (c.type === "update" ? c.moves : []));
    expect(moves.filter((m) => m.market === "total")).toEqual([
      { gameId: "34118112", period: "full", market: "total", side: "over", selectionId: "0OU84695545O3950_1", source: "ws", from: { line: 40.5, american: -108, decimal: 1.92 }, to: { line: 39.5, american: -115, decimal: 1.86 } },
      { gameId: "34118112", period: "full", market: "total", side: "under", selectionId: "0OU84695545U3950_3", source: "ws", from: { line: 40.5, american: -112, decimal: 1.89 }, to: { line: 39.5, american: -105, decimal: 1.95 } },
    ]);
    expect(engine.counters.moves).toBe(4); // and the moneyline moved in the same burst
    expect(engine.games().find((g) => g.id === "34118112")!.markets.full.total!.selections).toMatchObject([
      { side: "over", line: 39.5, prev: { line: 40.5, american: -108 } },
      { side: "under", line: 39.5, prev: { line: 40.5, american: -112 } },
    ]);
  });

  it("keeps a market on the board, without prices, while DraftKings swaps its line", async () => {
    // Same real frames. DK removes the old sides but keeps the market; line history asks for markets by id.
    const { engine } = setup();
    await engine.resync();
    const seen: string[] = [];
    for (const raw of loadWsFrames().filter((f) => f.includes("84695545"))) {
      const { delta, meta } = parseUpdate(raw);
      engine.apply(delta, meta, Date.now());
      const total = engine.games().find((g) => g.id === "34118112")!.markets.full.total;
      const state = `${total?.id}: ${total?.selections.map((s) => `${s.side} ${s.line}`).join(", ")}`;
      if (seen.at(-1) !== state) seen.push(state);
    }
    expect(seen).toEqual([
      "3_84695545: over 40.5, under 40.5",
      "3_84695545: under 40.5",
      "3_84695545: ",
      "3_84695545: over 39.5",
      "3_84695545: over 39.5, under 39.5",
    ]);
  });

  it("doesn't report a side that DraftKings drops and puts back at the same price", async () => {
    const { engine, changes } = setup();
    await engine.resync();
    const over = structuredClone(loadSnapshot().selections.find((s) => s.id === "0OU84695545O4050_1")!);
    engine.apply(deltaOf((d) => d.remove.selections.push(over.id)), meta(), Date.now());
    engine.apply(deltaOf((d) => d.add.selections.push(over)), meta(), Date.now());
    expect(changes.filter((c) => c.type === "update")).toHaveLength(2);
    expect(engine.counters.moves).toBe(0);
  });

  it("re-checks when an update references something it doesn't know", async () => {
    const { engine, fetch } = setup();
    await engine.resync();
    engine.apply(deltaOf((d) => d.change.selections.push({ id: "0HC999N300_1", displayOdds: odds(-110, 1.91) })), meta(), Date.now());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(engine.counters.unresolved).toBe(1);
  });

  it("reports a failed load, keeps the last good board, and recovers", async () => {
    let fail = false;
    const base = loadSnapshot();
    const { engine, last } = setup(async () => {
      if (fail) throw new Error("DraftKings snapshot returned HTTP 403 (blocked by Akamai)");
      return structuredClone(base);
    });
    await engine.resync();
    fail = true;
    expect(await engine.resync()).toBe(false);
    expect(engine).toMatchObject({ hasData: true, snapshotFailures: 1, snapshotError: "DraftKings snapshot returned HTTP 403 (blocked by Akamai)" });
    expect(engine.games()).toHaveLength(32);
    fail = false;
    await engine.resync();
    expect(engine.snapshotError).toBeNull();
    expect(last("snapshot").games).toHaveLength(32);
  });
});

describe("BoardEngine, 1st half", () => {
  // LA Chargers @ BUF Bills in the fixtures: moneyline LAC +270 for the game, +200 for the 1st half.
  const HALF_GAME = "34118212";
  const HALF_MARKETS = ["1_86410040", "2_86410040", "3_86410040"];
  const game = (games: Game[]) => games.find((g) => g.id === HALF_GAME)!;
  /** The 1st-half markets and sides for one game, as DraftKings would add them. */
  const halfLinesPosted = () => {
    const half = loadHalfSnapshot();
    const markets = half.markets.filter((m) => m.eventId === HALF_GAME);
    const ids = new Set(markets.map((m) => m.id));
    return deltaOf((d) => {
      d.add.markets.push(...markets);
      d.add.selections.push(...half.selections.filter((s) => ids.has(s.marketId!)));
    });
  };

  it("moves only the 1st half when a 1st-half price changes", async () => {
    const { engine, last } = setup(undefined, loadBoardSnapshot());
    await engine.resync();
    engine.apply(deltaOf((d) => d.change.selections.push({ id: "0ML86410040_3", displayOdds: odds(220, 3.2) })), meta(), Date.now());
    const update = last("update");
    expect(update.moves).toEqual([
      expect.objectContaining({ gameId: HALF_GAME, period: "half", market: "moneyline", side: "away", from: expect.objectContaining({ american: 200 }), to: expect.objectContaining({ american: 220 }) }),
    ]);
    expect(awayMoneyline(update.games, HALF_GAME, "half")).toMatchObject({ american: 220, prev: { american: 200 } });
    const full = awayMoneyline(update.games, HALF_GAME, "full");
    expect(full.american).toBe(270);
    expect(full.prev).toBeUndefined();
  });

  it("keeps a full-game move and a 1st-half move on the same side apart", async () => {
    const { engine, last } = setup(undefined, loadBoardSnapshot());
    await engine.resync();
    engine.apply(
      deltaOf((d) => d.change.selections.push({ id: "0ML84695645_3", displayOdds: odds(280, 3.8) }, { id: "0ML86410040_3", displayOdds: odds(210, 3.1) })),
      meta(),
      Date.now(),
    );
    const update = last("update");
    expect(update.moves.map((m) => [m.period, m.side, m.from.american, m.to.american])).toEqual([
      ["full", "away", 270, 280],
      ["half", "away", 200, 210],
    ]);
    expect(awayMoneyline(update.games, HALF_GAME, "full")).toMatchObject({ american: 280, prev: { american: 270 } });
    expect(awayMoneyline(update.games, HALF_GAME, "half")).toMatchObject({ american: 210, prev: { american: 200 } });
  });

  it("compares a 1st-half line sent as remove-then-add with the 1st half's last price, not the game's", async () => {
    // LAC 1st-half spread +4.5 −120 (the full-game spread is +7 −108).
    const { engine, changes } = setup(undefined, loadBoardSnapshot());
    await engine.resync();
    engine.apply(deltaOf((d) => d.remove.selections.push("0HC86410040P450_3")), meta(), Date.now());
    engine.apply(
      deltaOf((d) =>
        d.add.selections.push({ id: "0HC86410040P400_3", marketId: "2_86410040", outcomeType: "Away", label: "LA Chargers", points: 4, displayOdds: odds(-110, 1.91), tags: ["MainPointLine"] }),
      ),
      meta(),
      Date.now(),
    );
    const moves = changes.flatMap((c) => (c.type === "update" ? c.moves : []));
    expect(moves).toEqual([
      expect.objectContaining({ period: "half", market: "spread", side: "away", from: { line: 4.5, american: -120, decimal: 1.83 }, to: { line: 4, american: -110, decimal: 1.91 } }),
    ]);
  });

  it("shows 1st-half lines DraftKings posts later straight from the feed, without a re-check", async () => {
    const { engine, fetch, last } = setup(); // the board before any 1st-half lines were posted
    await engine.resync();
    expect(game(engine.games()).markets.half).toEqual({});

    engine.apply(halfLinesPosted(), meta(), Date.now());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(engine.counters.unresolved).toBe(0);
    const update = last("update");
    expect(Object.keys(game(update.games).markets.half)).toEqual(["moneyline", "spread", "total"]);
    expect(awayMoneyline(update.games, HALF_GAME, "half").american).toBe(200);
    expect(update.moves).toEqual([]); // new lines, not moves
  });

  it("replays 1st-half lines that arrive before the board loads", async () => {
    const { engine, last } = setup();
    engine.apply(halfLinesPosted(), meta(), Date.now());
    await engine.resync();
    expect(awayMoneyline(last("snapshot").games, HALF_GAME, "half").american).toBe(200);
  });

  it("empties the 1st half, and only the 1st half, when DraftKings takes it down mid-game", async () => {
    const { engine, last } = setup(undefined, loadBoardSnapshot());
    await engine.resync();
    engine.apply(
      deltaOf((d) => {
        d.remove.markets.push(...HALF_MARKETS);
        d.change.events.push({ id: HALF_GAME, status: "STARTED" });
      }),
      meta(),
      Date.now(),
    );
    const g = game(last("update").games);
    expect(g.status).toBe("STARTED");
    expect(g.markets.half).toEqual({});
    expect(Object.keys(g.markets.full)).toEqual(["moneyline", "spread", "total"]);
  });

  it("pauses a 1st-half market without touching the game's", async () => {
    const { engine, last } = setup(undefined, loadBoardSnapshot());
    await engine.resync();
    engine.apply(deltaOf((d) => d.change.markets.push({ id: "1_86410040", isSuspended: true })), meta(), Date.now());
    const g = game(last("update").games);
    expect(g.markets.half.moneyline!.suspended).toBe(true);
    expect(g.markets.full.moneyline!.suspended).toBe(false);
  });
});
