import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DkSnapshot } from "@/lib/dk/schema";
import { BoardEngine, type BoardChange } from "@/lib/odds/engine";
import { deltaOf, loadSnapshot, loadWsFrames, odds, parseUpdate } from "./helpers";

// BoardEngine runs in the browser (and on the server where DK's REST board is reachable).

const GAME = "34118180";
const priceChange = (american: number) =>
  deltaOf((d) => d.change.selections.push({ id: "0ML84695613_3", displayOdds: odds(american, 1 + american / 100) }));
const meta = () => ({ createdTime: new Date(Date.now() - 80).toISOString(), publishedTime: null, wsPublishedTime: null });

function setup(fetchSnapshot?: () => Promise<DkSnapshot>) {
  const base = loadSnapshot();
  const fetch = vi.fn(fetchSnapshot ?? (async () => structuredClone(base)));
  const changes: BoardChange[] = [];
  const engine = new BoardEngine({ fetchSnapshot: fetch, onChange: (c) => changes.push(c), now: () => Date.now() });
  const last = <T extends BoardChange["type"]>(type: T) => changes.filter((c) => c.type === type).at(-1) as Extract<BoardChange, { type: T }>;
  return { engine, fetch, changes, last };
}

const awayMoneyline = (games: { id: string; markets: { moneyline?: { selections: { american: number }[] } } }[]) =>
  games.find((g) => g.id === GAME)!.markets.moneyline!.selections[0];

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
      { gameId: "34118112", market: "total", side: "over", selectionId: "0OU84695545O3950_1", source: "ws", from: { line: 40.5, american: -108, decimal: 1.92 }, to: { line: 39.5, american: -115, decimal: 1.86 } },
      { gameId: "34118112", market: "total", side: "under", selectionId: "0OU84695545U3950_3", source: "ws", from: { line: 40.5, american: -112, decimal: 1.89 }, to: { line: 39.5, american: -105, decimal: 1.95 } },
    ]);
    expect(engine.counters.moves).toBe(4); // and the moneyline moved in the same burst
    expect(engine.games().find((g) => g.id === "34118112")!.markets.total!.selections).toMatchObject([
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
      const total = engine.games().find((g) => g.id === "34118112")!.markets.total;
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
