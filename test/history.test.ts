import { describe, expect, it } from "vitest";
import { boardSides, PriceTracker } from "@/lib/dk/prices";
import { lineMoves, mergeMoves, placeChanges } from "@/lib/odds/history";
import { normalizeGames } from "@/lib/odds/normalize";
import { DkStore } from "@/lib/odds/store";
import type { RecordedChange } from "@/lib/odds/types";
import { deltaOf, loadSnapshot, loadWsFrames, odds, parseUpdate } from "./helpers";

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
    const sides = boardSides(board().values()).map((s) => (s.selectionId === OVER ? { ...s, selectionId: "0OU84695613O4350_1", line: 43.5 } : s));
    t.takeBoard(sides, "viewer", NOW);
    const [change] = t.observe(deltaOf((d) => d.change.selections.push({ id: OVER, label: "Over", points: 44.5, displayOdds: odds(-110, 1.91) })));
    expect(change).toMatchObject({ from: null, fromSource: null, to: { line: 44.5, american: -110 } });
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

  it("drops changes for markets that are no longer on the board", () => {
    expect(placeChanges(board().values(), [change({ marketId: "1_999" })])).toEqual([]);
  });

  it("merges live and recorded moves newest first, each once, preferring the live copy", () => {
    const games = board();
    const at = "2026-09-22T19:30:00.000Z";
    // Seen live on the page, and also recorded, but by an instance that didn't know the price before.
    const live = lineMoves(
      [{ gameId: GAME, market: "moneyline", side: "away", selectionId: ATL_ML, from: { line: null, american: 250, decimal: 3.5 }, to: { line: null, american: 260, decimal: 3.6 } }],
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
