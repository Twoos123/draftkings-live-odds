import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DkSnapshot } from "@/lib/dk/schema";
import { BoardEngine, type BoardChange } from "@/lib/odds/engine";
import { deltaOf, loadSnapshot, odds } from "./helpers";

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
