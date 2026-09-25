import { describe, expect, it } from "vitest";
import { boardSides, PriceTracker } from "@/lib/dk/prices";
import { lineMoves, marketIds, mergeMoves, placeChanges } from "@/lib/odds/history";
import { normalizeGames } from "@/lib/odds/normalize";
import { DkStore } from "@/lib/odds/store";
import type { RecordedChange } from "@/lib/odds/types";
import { deltaOf, loadBoardSnapshot, loadSnapshot, loadWsFrames, odds, parseUpdate } from "./helpers";

// ATL Falcons @ GB Packers in the fixture: moneyline ATL +235, total 44.5 (Over −102).
const GAME = "34118180";
const ATL_ML = "0ML84695613_3";
const OVER = "0OU84695613O4450_1";
const NOW = Date.parse("2026-09-22T20:00:00Z");

function board() {
  return normalizeGames(DkStore.fromSnapshot(loadSnapshot()));
}

const atlMoneyline = (american: number) =>
  deltaOf((d) => d.change.selections.push({ id: ATL_ML, label: "ATL Falcons", displayOdds: odds(american, 1 + american / 100) }));

const overMovesTo = (points: number, american: number, how: "replace" | "add-remove" = "replace") =>
  deltaOf((d) => {
    const id = `0OU84695613O${points * 100}_1`;
    if (how === "replace") d.change.selections.push({ id, label: "Over", points, displayOdds: odds(american, 1.9), replacedSelectionId: OVER });
    else {
      d.add.selections.push({ id, marketId: "3_84695613", label: "Over", points, displayOdds: odds(american, 1.9), outcomeType: "Over" });
      d.remove.selections.push(OVER);
    }
  });

function tracker(source: "board" | "viewer" = "viewer") {
  const t = new PriceTracker();
  t.takeBoard(boardSides(board().values()), source, NOW);
  return t;
}

describe("PriceTracker (line history from the push feed)", () => {
  it("takes the price before a side's first move from the board, and later ones from the feed", () => {
    const t = tracker();
    expect(t.observe(atlMoneyline(250))).toEqual([
      {
        marketId: "1_84695613",
        selectionId: ATL_ML,
        label: "ATL Falcons",
        from: { line: null, american: 235, decimal: 3.35 },
        to: { line: null, american: 250, decimal: 3.5 },
        fromSource: "viewer",
      },
    ]);
    expect(t.observe(atlMoneyline(255))[0]).toMatchObject({ from: { american: 250 }, to: { american: 255 }, fromSource: "feed" });
  });

  it("handles a partial change that leaves out the label", () => {
    const [change] = tracker().observe(deltaOf((d) => d.change.selections.push({ id: ATL_ML, displayOdds: odds(250, 3.5) })));
    expect(change).toMatchObject({ label: "ATL Falcons", from: { american: 235 }, to: { american: 250 } });
  });

  it("works out markets from the board and the feed, not from the format of DraftKings' ids", () => {
    // The same board, with every id renamed to something meaningless.
    const ids = new Map<string, string>();
    const opaque = (id: string) => {
      if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
      return ids.get(id)!;
    };
    const t = new PriceTracker();
    t.takeBoard(boardSides(board().values()).map((s) => ({ ...s, marketId: opaque(s.marketId), selectionId: opaque(s.selectionId) })), "viewer", NOW);

    // A price change that names only the selection.
    const [price] = t.observe(deltaOf((d) => d.change.selections.push({ id: opaque(ATL_ML), displayOdds: odds(250, 3.5) })));
    expect(price).toMatchObject({ marketId: opaque("1_84695613"), label: "ATL Falcons", from: { american: 235 }, to: { american: 250 } });

    // A line move to a new id, which names the one it replaced; then that new id's next change.
    const [line] = t.observe(deltaOf((d) => d.change.selections.push({ id: "new-over", points: 45.5, displayOdds: odds(-110, 1.91), replacedSelectionId: opaque(OVER) })));
    expect(line).toMatchObject({ marketId: opaque("3_84695613"), label: "Over", from: { line: 44.5 }, to: { line: 45.5 } });
    const [next] = t.observe(deltaOf((d) => d.change.selections.push({ id: "new-over", displayOdds: odds(-120, 1.83) })));
    expect(next).toMatchObject({ from: { line: 45.5, american: -110 }, to: { line: 45.5, american: -120 } });

    // A total's new line that leaves out the points can't be recorded.
    expect(t.observe(deltaOf((d) => d.change.selections.push({ id: "newer-over", displayOdds: odds(-105, 1.95), replacedSelectionId: "new-over" })))).toEqual([]);
  });

  it("skips updates that leave the price as it was", () => {
    const t = tracker();
    t.observe(atlMoneyline(250));
    expect(t.observe(atlMoneyline(250))).toEqual([]);
  });

  it("follows a line move to a new selection id, however DraftKings sends it", () => {
    expect(tracker().observe(overMovesTo(45.5, -110))[0]).toMatchObject({
      selectionId: "0OU84695613O4550_1",
      from: { line: 44.5, american: -102 },
      to: { line: 45.5, american: -110 },
    });
    expect(tracker().observe(overMovesTo(45.5, -110, "add-remove"))[0]).toMatchObject({ from: { line: 44.5 }, to: { line: 45.5 } });
  });

  it("records nothing until it has a board, and only that board's markets", () => {
    const t = new PriceTracker();
    expect(t.needsBoard(NOW)).toBe(true);
    expect(t.observe(atlMoneyline(250))).toEqual([]);

    // The feed also carries other sports' markets (these are MLB, recorded from the real feed).
    const other = loadWsFrames()
      .map((raw) => (raw.includes('"PHI Phillies"') ? parseUpdate(raw).delta : null))
      .find(Boolean)!;
    expect(tracker().observe(other)).toEqual([]);
  });

  it("doesn't use a board price for a different line than the one that moved", () => {
    const t = new PriceTracker();
    // An out-of-date board: the Over was 43.5 then.
    const sides = boardSides(board().values()).map((s) => (s.selectionId === OVER ? { ...s, selectionId: "0OU84695613O4350_1", line: 43.5 } : s));
    t.takeBoard(sides, "viewer", NOW);
    const [change] = t.observe(
      deltaOf((d) => d.add.selections.push({ id: OVER, marketId: "3_84695613", label: "Over", points: 44.5, displayOdds: odds(-110, 1.91) })),
    );
    expect(change).toMatchObject({ from: null, fromSource: null, to: { line: 44.5, american: -110 } });
  });

  it("skips a change it can't place rather than guessing from the id", () => {
    // Never seen, no marketId, and not replacing anything it knows.
    expect(tracker().observe(deltaOf((d) => d.change.selections.push({ id: "0OU84695613O4650_1", label: "Over", points: 46.5, displayOdds: odds(-110, 1.91) })))).toEqual([]);
  });

  it("prefers what the feed said over an older copy of the board", () => {
    const t = tracker();
    t.observe(atlMoneyline(250));
    t.takeBoard(boardSides(board().values()), "viewer", NOW + 1000); // still says +235
    expect(t.observe(atlMoneyline(260))[0]).toMatchObject({ from: { american: 250 }, fromSource: "feed" });
  });

  it("forgets prices after a reconnect, and asks for the board again", () => {
    const t = tracker();
    expect(t.needsBoard(NOW + 60_000)).toBe(false);
    t.forgetPrices();
    expect(t.needsBoard(NOW + 60_000)).toBe(true);
    expect(t.observe(atlMoneyline(250))[0]).toMatchObject({ from: null, to: { american: 250 } });
  });

  it("asks for a fresh copy of the board every 10 minutes", () => {
    const t = tracker();
    expect(t.needsBoard(NOW + 9 * 60_000)).toBe(false);
    expect(t.needsBoard(NOW + 11 * 60_000)).toBe(true);
  });
});

describe("placing recorded changes on the board", () => {
  const change = (over: Partial<RecordedChange>): RecordedChange => ({
    marketId: "1_84695613",
    selectionId: ATL_ML,
    label: "ATL Falcons",
    to: { line: null, american: 250, decimal: 3.5 },
    from: { line: null, american: 235, decimal: 3.35 },
    fromSource: "feed",
    at: "2026-09-22T19:00:00.000Z",
    ...over,
  });

  it("finds each change's game, market and side from DraftKings' ids and labels", () => {
    const moves = placeChanges(board().values(), [change({}), change({ marketId: "3_84695613", label: "Under", selectionId: "0OU84695613U4450_3" })]);
    expect(moves.map(({ gameId, market, side }) => ({ gameId, market, side }))).toEqual([
      { gameId: GAME, market: "moneyline", side: "away" },
      { gameId: GAME, market: "total", side: "under" },
    ]);
  });

  it("still asks about and places a market while DraftKings swaps its line", () => {
    // Mid swap: DK has removed the old Over and Under, and not yet added the new ones.
    const store = DkStore.fromSnapshot(loadSnapshot());
    store.apply(deltaOf((d) => d.remove.selections.push(OVER, "0OU84695613U4450_3")));
    const games = normalizeGames(store);
    expect(marketIds([games.get(GAME)!])).toContain("3_84695613");
    const moves = placeChanges(games.values(), [change({ marketId: "3_84695613", label: "Over", selectionId: OVER })]);
    expect(moves.map(({ gameId, market, side }) => ({ gameId, market, side }))).toEqual([{ gameId: GAME, market: "total", side: "over" }]);
  });

  it("drops changes for markets that are no longer on the board", () => {
    expect(placeChanges(board().values(), [change({ marketId: "1_999" })])).toEqual([]);
  });

  it("merges live and recorded moves newest first, each once, preferring the live copy", () => {
    const games = board();
    const at = "2026-09-22T19:30:00.000Z";
    // Seen live on the page, and also recorded, but by an instance that didn't know the price before.
    const live = lineMoves(
      [{ gameId: GAME, period: "full", market: "moneyline", side: "away", selectionId: ATL_ML, from: { line: null, american: 250, decimal: 3.5 }, to: { line: null, american: 260, decimal: 3.6 } }],
      Date.parse(at),
    );
    const recorded = placeChanges(games.values(), [change({}), change({ from: null, at })]);
    const merged = mergeMoves(live, recorded);
    expect(merged.map((m) => [m.at, m.from?.american ?? null])).toEqual([
      [Date.parse(at), 250],
      [Date.parse("2026-09-22T19:00:00.000Z"), 235],
    ]);
  });
});

describe("line history, 1st half", () => {
  // LA Chargers @ BUF Bills: moneyline LAC +270 for the game, +200 for the 1st half.
  const HALF_GAME = "34118212";
  const at = "2026-09-26T19:00:00.000Z";
  const both = () => normalizeGames(DkStore.fromSnapshot(loadBoardSnapshot()));
  const lacMoneyline = (marketId: string, selectionId: string, from: number, to: number): RecordedChange => ({
    marketId,
    selectionId,
    label: "LA Chargers",
    from: { line: null, american: from, decimal: 1 + from / 100 },
    to: { line: null, american: to, decimal: 1 + to / 100 },
    fromSource: "feed",
    at,
  });

  it("asks about one period's markets at a time", () => {
    const games = both();
    const g = games.get(HALF_GAME)!;
    expect(marketIds([g], "full")).toEqual(["1_84695645", "2_84695645", "3_84695645"]);
    expect(marketIds([g], "half")).toEqual(["1_86410040", "2_86410040", "3_86410040"]);
    expect(marketIds([g])).toHaveLength(6);
    expect(marketIds([games.get(GAME)!], "half")).toEqual([]); // ATL @ GB: none posted
  });

  it("places full-game and 1st-half changes in their own period, even at the same moment", () => {
    const moves = placeChanges(both().values(), [lacMoneyline("1_84695645", "0ML84695645_3", 270, 280), lacMoneyline("1_86410040", "0ML86410040_3", 200, 210)]);
    expect(moves.map(({ period, market, side }) => ({ period, market, side }))).toEqual([
      { period: "full", market: "moneyline", side: "away" },
      { period: "half", market: "moneyline", side: "away" },
    ]);
    // Same game, side and time: only the period tells them apart.
    expect(mergeMoves(moves)).toHaveLength(2);
  });

  it("merges a live 1st-half move with its recorded copy", () => {
    const live = lineMoves(
      [{ gameId: HALF_GAME, period: "half", market: "moneyline", side: "away", selectionId: "0ML86410040_3", from: { line: null, american: 200, decimal: 3 }, to: { line: null, american: 210, decimal: 3.1 } }],
      Date.parse(at),
    );
    const recorded = placeChanges(both().values(), [lacMoneyline("1_86410040", "0ML86410040_3", 200, 210)]);
    expect(live[0].key).toBe(recorded[0].key);
    expect(mergeMoves(live, recorded)).toEqual(live);
  });

  it("records 1st-half price changes from the feed, with the board's price before", () => {
    const t = new PriceTracker();
    const sides = boardSides(both().values());
    expect(sides).toHaveLength(192 + 84); // every full-game side, plus the 14 Sunday games' 1st halves
    t.takeBoard(sides, "viewer", NOW);
    expect(t.observe(deltaOf((d) => d.change.selections.push({ id: "0ML86410040_3", displayOdds: odds(210, 3.1) })))).toEqual([
      {
        marketId: "1_86410040",
        selectionId: "0ML86410040_3",
        label: "LA Chargers",
        from: { line: null, american: 200, decimal: 3 },
        to: { line: null, american: 210, decimal: 3.1 },
        fromSource: "viewer",
      },
    ]);
  });
});
