import { describe, expect, it } from "vitest";
import { parseAmerican } from "@/lib/odds/format";
import { normalizeGames } from "@/lib/odds/normalize";
import { DkStore } from "@/lib/odds/store";
import { loadSnapshot } from "./helpers";

describe("normalizeGames (real DraftKings snapshot)", () => {
  const games = normalizeGames(DkStore.fromSnapshot(loadSnapshot()));

  it("maps every game with all three main markets", () => {
    expect(games.size).toBe(32);
    for (const g of games.values()) {
      expect(Object.keys(g.markets).sort()).toEqual(["moneyline", "spread", "total"]);
    }
  });

  it("orders sides away/home and over/under with sane prices", () => {
    for (const g of games.values()) {
      expect(g.markets.moneyline!.selections.map((s) => s.side)).toEqual(["away", "home"]);
      expect(g.markets.spread!.selections.map((s) => s.side)).toEqual(["away", "home"]);
      expect(g.markets.total!.selections.map((s) => s.side)).toEqual(["over", "under"]);
      const [awaySpread, homeSpread] = g.markets.spread!.selections;
      expect(awaySpread.line).toBe(-homeSpread.line!);
      const [over, under] = g.markets.total!.selections;
      expect(over.line).toBe(under.line);
      for (const m of Object.values(g.markets)) {
        for (const s of m!.selections) {
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
    expect(g.markets.moneyline!.selections[1]).toMatchObject({ side: "home", american: -290 });
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
