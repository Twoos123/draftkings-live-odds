import { describe, expect, it } from "vitest";
import { parseWsMessage } from "@/lib/dk/schema";
import { diffGames, normalizeGames } from "@/lib/odds/normalize";
import { DkStore, inferMarketId } from "@/lib/odds/store";
import { deltaOf, loadSnapshot, loadWsFrames, odds, parseUpdate, updateFrame } from "./helpers";

function setup() {
  const store = DkStore.fromSnapshot(loadSnapshot());
  return { store, before: normalizeGames(store) };
}

const GAME = "34118180"; // ATL Falcons @ GB Packers in the fixture

describe("DkStore.apply", () => {
  it("applies the real NFL market updates we recorded without losing anything", () => {
    const { store, before } = setup();
    const nflFrames = loadWsFrames()
      .map((raw) => parseWsMessage(raw))
      .filter((m) => m.kind === "update")
      .filter((m) => m.delta.change.markets.some((mk) => store.markets.has(mk.id)));
    expect(nflFrames.length).toBeGreaterThan(0);
    for (const m of nflFrames) {
      const res = store.apply(m.delta);
      expect(res.unresolved).toEqual([]);
      expect(res.touched.size).toBe(1);
    }
    // These frames were suspension toggles, so no prices moved.
    expect(diffGames(before, normalizeGames(store)).moves).toEqual([]);
  });

  it("merges a partial price change onto the existing selection", () => {
    const { store, before } = setup();
    const { delta } = parseUpdate(
      updateFrame({
        change: { selections: [{ id: "0ML84695613_3", label: "ATL Falcons", displayOdds: odds(250, 3.5), trueOdds: 3.5 }] },
      }),
    );
    const res = store.apply(delta);
    expect(res.unresolved).toEqual([]);
    expect([...res.touched]).toEqual([GAME]);

    const diff = diffGames(before, normalizeGames(store));
    expect(diff.moves).toEqual([
      {
        gameId: GAME,
        market: "moneyline",
        side: "away",
        selectionId: "0ML84695613_3",
        from: { line: null, american: 235, decimal: 3.35 },
        to: { line: null, american: 250, decimal: 3.5 },
      },
    ]);
  });

  it("follows replacedSelectionId when a total moves to a new line", () => {
    // Same shape as a real MLB frame we recorded: new id, no marketId, points to the old id.
    const { store, before } = setup();
    const { delta } = parseUpdate(
      updateFrame({
        change: {
          selections: [
            { id: "0OU84695613O4550_1", label: "Over", displayOdds: odds(-110, 1.91), trueOdds: 1.91, points: 45.5, replacedSelectionId: "0OU84695613O4450_1" },
            { id: "0OU84695613U4550_3", label: "Under", displayOdds: odds(-110, 1.91), trueOdds: 1.91, points: 45.5, replacedSelectionId: "0OU84695613U4450_3" },
          ],
        },
      }),
    );
    const res = store.apply(delta);
    expect(res.unresolved).toEqual([]);
    expect(store.selections.has("0OU84695613O4450_1")).toBe(false);
    expect(store.selections.get("0OU84695613O4550_1")).toMatchObject({ marketId: "3_84695613", outcomeType: "Over", points: 45.5 });

    const after = normalizeGames(store);
    expect(after.get(GAME)!.markets.total!.selections.map((s) => [s.side, s.line, s.american])).toEqual([
      ["over", 45.5, -110],
      ["under", 45.5, -110],
    ]);
    const moves = diffGames(before, after).moves;
    expect(moves.map((m) => [m.side, m.from.line, m.to.line])).toEqual([
      ["over", 44.5, 45.5],
      ["under", 44.5, 45.5],
    ]);
  });

  it("handles a line move sent as add + remove", () => {
    const { store } = setup();
    const res = store.apply(
      deltaOf((d) => {
        d.add.selections.push({ id: "0HC84695613P650_3", marketId: "2_84695613", outcomeType: "Away", label: "ATL Falcons", points: 6.5, displayOdds: odds(-115, 1.87) });
        d.remove.selections.push("0HC84695613P600_3");
      }),
    );
    expect(res.unresolved).toEqual([]);
    const away = normalizeGames(store).get(GAME)!.markets.spread!.selections[0];
    expect(away).toMatchObject({ id: "0HC84695613P650_3", line: 6.5, american: -115 });
  });

  it("suspends and removes markets and games", () => {
    const { store } = setup();
    store.apply(deltaOf((d) => d.change.markets.push({ id: "2_84695613", isSuspended: true })));
    expect(normalizeGames(store).get(GAME)!.markets.spread!.suspended).toBe(true);

    store.apply(deltaOf((d) => d.remove.markets.push("2_84695613")));
    expect(normalizeGames(store).get(GAME)!.markets.spread).toBeUndefined();
    expect([...store.selections.values()].some((s) => s.marketId === "2_84695613")).toBe(false);

    const res = store.apply(deltaOf((d) => d.remove.events.push(GAME)));
    expect(res.touched.has(GAME)).toBe(true);
    expect(normalizeGames(store).has(GAME)).toBe(false);
    expect([...store.markets.values()].some((m) => m.eventId === GAME)).toBe(false);
  });

  it("reports changes it can't place instead of guessing", () => {
    const { store } = setup();
    const res = store.apply(
      deltaOf((d) => {
        d.change.selections.push({ id: "0QA999#1", displayOdds: odds(120, 2.2) });
        d.change.markets.push({ id: "9_999", isSuspended: true });
        d.change.events.push({ id: "999", status: "STARTED" });
      }),
    );
    expect(res.unresolved.sort()).toEqual(["event:999", "market:9_999", "selection:0QA999#1"]);
    expect(res.touched.size).toBe(0);
  });
});

describe("DkStore indexes", () => {
  function expectIndexesMatchData(store: DkStore) {
    for (const eventId of store.events.keys()) {
      const expected = [...store.markets.values()].filter((m) => m.eventId === eventId).map((m) => m.id).sort();
      expect(store.marketsOf(eventId).map((m) => m.id).sort()).toEqual(expected);
    }
    for (const marketId of store.markets.keys()) {
      const expected = [...store.selections.values()].filter((s) => s.marketId === marketId).map((s) => s.id).sort();
      expect(store.selectionsOf(marketId).map((s) => s.id).sort()).toEqual(expected);
    }
  }

  it("stay in step with the data through line moves, adds and removals", () => {
    const { store } = setup();
    expectIndexesMatchData(store);
    store.apply(
      deltaOf((d) => {
        d.change.selections.push({ id: "0OU84695613O4550_1", points: 45.5, displayOdds: odds(-110, 1.91), replacedSelectionId: "0OU84695613O4450_1" });
        d.add.selections.push({ id: "0HC84695613P650_3", marketId: "2_84695613", outcomeType: "Away", points: 6.5, displayOdds: odds(-115, 1.87) });
        d.remove.selections.push("0HC84695613P600_3");
        d.remove.markets.push("1_84695613");
      }),
    );
    expectIndexesMatchData(store);
    store.apply(deltaOf((d) => d.remove.events.push(GAME)));
    expectIndexesMatchData(store);
    expect(store.marketsOf(GAME)).toEqual([]);
  });
});

describe("inferMarketId", () => {
  it("reads the market out of main-line selection ids", () => {
    expect(inferMarketId("0ML84695613_3")).toBe("1_84695613");
    expect(inferMarketId("0HC84695613N600_1")).toBe("2_84695613");
    expect(inferMarketId("0OU84695613O4450_1")).toBe("3_84695613");
    expect(inferMarketId("0QA372230232#2294390952_13L84240Q1")).toBeNull();
  });
});

describe("parseWsMessage", () => {
  it("parses every recorded frame", () => {
    const kinds = loadWsFrames().map((raw) => parseWsMessage(raw).kind);
    expect(kinds[0]).toBe("subscribed");
    expect(kinds.slice(1).every((k) => k === "update")).toBe(true);
  });

  it("keeps replacedSelectionId from the real MLB line-move frames", () => {
    const replaced = loadWsFrames()
      .map((raw) => parseWsMessage(raw))
      .flatMap((m) => (m.kind === "update" ? m.delta.change.selections : []))
      .filter((s) => s.replacedSelectionId);
    expect(replaced.length).toBeGreaterThan(0);
    expect(replaced[0].replacedSelectionId).toMatch(/^0(OU|HC|ML)/);
  });

  it("survives junk without throwing", () => {
    expect(parseWsMessage("not json").kind).toBe("invalid");
    expect(parseWsMessage("{}").kind).toBe("invalid");
    expect(parseWsMessage(JSON.stringify({ event: "update", data: "x" })).kind).toBe("invalid");
    const issues: string[] = [];
    const m = parseWsMessage(
      updateFrame({ change: { selections: [{ nope: 1 }, { id: "0ML1_1", points: "bad" }], markets: "wrong" } }),
      (where) => issues.push(where),
    );
    expect(m.kind).toBe("update");
    expect(m.kind === "update" && m.delta.change.selections).toEqual([]);
    expect(issues).toEqual(["change.markets", "change.selections", "change.selections"]);
  });
});
