import { describe, expect, it } from "vitest";
import { parseAmerican } from "@/lib/odds/format";
import { allMarkets, diffGames, normalizeGames } from "@/lib/odds/normalize";
import { DkStore } from "@/lib/odds/store";
import { deltaOf, loadBoardSnapshot, loadHalfSnapshot, loadSnapshot, odds } from "./helpers";

describe("normalizeGames (real DraftKings snapshot)", () => {
  const games = normalizeGames(DkStore.fromSnapshot(loadSnapshot()));

  it("maps every game with all three main markets", () => {
    expect(games.size).toBe(32);
    for (const g of games.values()) {
      expect(Object.keys(g.markets.full)).toEqual(["moneyline", "spread", "total"]);
      expect(g.markets.half).toEqual({});
    }
  });

  it("orders sides away/home and over/under with sane prices", () => {
    for (const g of games.values()) {
      expect(g.markets.full.moneyline!.selections.map((s) => s.side)).toEqual(["away", "home"]);
      expect(g.markets.full.spread!.selections.map((s) => s.side)).toEqual(["away", "home"]);
      expect(g.markets.full.total!.selections.map((s) => s.side)).toEqual(["over", "under"]);
      const [awaySpread, homeSpread] = g.markets.full.spread!.selections;
      expect(awaySpread.line).toBe(-homeSpread.line!);
      const [over, under] = g.markets.full.total!.selections;
      expect(over.line).toBe(under.line);
      for (const m of allMarkets(g)) {
        for (const s of m.selections) {
          expect(Math.abs(s.american)).toBeGreaterThanOrEqual(100);
          expect(s.decimal).toBeGreaterThan(1);
        }
      }
    }
  });

  it("uses the home/away participants for team names", () => {
    const g = games.get("34118180")!;
    expect(g.away.name).toBe("ATL Falcons");
    expect(g.home.short).toBe("GB");
    expect(g.markets.full.moneyline!.selections[1]).toMatchObject({ side: "home", american: -290 });
  });
});

describe("normalizeGames, full game and 1st half (real snapshots)", () => {
  const games = normalizeGames(DkStore.fromSnapshot(loadBoardSnapshot()));
  const HALF_GAME = "34118212"; // LA Chargers @ BUF Bills, Sunday
  const NO_HALF = "34118180"; // ATL Falcons @ GB Packers: no 1st-half lines posted when captured

  it("tells DraftKings' 1st-half markets apart from the game's by name", () => {
    for (const m of loadHalfSnapshot().markets) expect(m.marketType?.name ?? m.name).toMatch(/^(Moneyline|Spread|Total) 1st Half$/);
    const g = games.get(HALF_GAME)!;
    expect(Object.keys(g.markets.full)).toEqual(["moneyline", "spread", "total"]);
    expect(Object.keys(g.markets.half)).toEqual(["moneyline", "spread", "total"]);
    for (const m of Object.values(g.markets.half)) expect(m!.period).toBe("half");
    for (const m of Object.values(g.markets.full)) expect(m!.period).toBe("full");
    expect(g.markets.full.moneyline!.selections.map((s) => s.american)).toEqual([270, -340]);
    expect(g.markets.half.moneyline!.selections.map((s) => s.american)).toEqual([200, -245]);
    expect(g.markets.half.spread!.selections.map((s) => [s.side, s.line, s.american])).toEqual([
      ["away", 4.5, -120],
      ["home", -4.5, 100],
    ]);
    expect(g.markets.half.total!.selections.map((s) => [s.side, s.line])).toEqual([
      ["over", 25.5],
      ["under", 25.5],
    ]);
  });

  it("gives the 14 Sunday games 1st-half lines and leaves the rest empty", () => {
    const withHalf = [...games.values()].filter((g) => Object.keys(g.markets.half).length > 0);
    expect(withHalf).toHaveLength(14);
    for (const g of withHalf) expect(Object.keys(g.markets.half)).toEqual(["moneyline", "spread", "total"]);
    expect(games.get(NO_HALF)!.markets.half).toEqual({});
    expect(games.size).toBe(32); // every game still listed
  });

  it("has every 1st-half market on the push feed's OSB filter, and every 1st-half game on the main board", () => {
    const half = loadHalfSnapshot();
    const full = loadSnapshot();
    for (const m of half.markets) expect(m.tags).toContain("OSB");
    const fullEvents = new Set(full.events.map((e) => e.id));
    for (const e of half.events) expect(fullEvents.has(e.id)).toBe(true);
  });

  it("ignores sides it doesn't know, such as a tie", () => {
    const store = DkStore.fromSnapshot(loadBoardSnapshot());
    store.apply(
      deltaOf((d) => d.add.selections.push({ id: "0ML86410040_2", marketId: "1_86410040", outcomeType: "Tie", label: "Tie", displayOdds: odds(1200, 13) })),
    );
    expect(normalizeGames(store).get(HALF_GAME)!.markets.half.moneyline!.selections.map((s) => s.side)).toEqual(["away", "home"]);
  });

  it("keeps markets in the same order however they arrive, so a re-add isn't a change", () => {
    const store = DkStore.fromSnapshot(loadBoardSnapshot());
    const before = normalizeGames(store);
    const market = structuredClone(store.markets.get("1_86410040")!);
    const sides = store.selectionsOf("1_86410040").map((s) => structuredClone(s));
    store.apply(deltaOf((d) => d.remove.markets.push("1_86410040")));
    store.apply(
      deltaOf((d) => {
        d.add.markets.push(market);
        d.add.selections.push(...sides);
      }),
    );
    const after = normalizeGames(store);
    expect(Object.keys(after.get(HALF_GAME)!.markets.half)).toEqual(["moneyline", "spread", "total"]);
    expect(diffGames(before, after)).toEqual({ changed: [], removed: [], moves: [] });
  });
});

describe("parseAmerican", () => {
  it("handles DraftKings' unicode minus and EVEN", () => {
    expect(parseAmerican("−110")).toBe(-110);
    expect(parseAmerican("+235")).toBe(235);
    expect(parseAmerican("EVEN")).toBe(100);
    expect(parseAmerican("")).toBeNull();
    expect(parseAmerican("garbage")).toBeNull();
  });
});
