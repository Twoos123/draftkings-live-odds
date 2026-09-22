import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopSink } from "@/lib/clickhouse";
import type { Feed, FeedHandlers, FeedState } from "@/lib/dk/feed";
import type { DkDelta, DkSnapshot } from "@/lib/dk/schema";
import { OddsHub } from "@/lib/hub";
import type { StreamMessage } from "@/lib/odds/types";
import { deltaOf, loadSnapshot, odds } from "./helpers";

class FakeFeed implements Feed {
  state: FeedState = "idle";
  subscribed = false;
  stopped = 0;
  reconnects = 0;
  constructor(readonly h: FeedHandlers) {}
  start() {
    this.state = "connecting";
  }
  stop() {
    this.stopped++;
    this.state = "idle";
    this.subscribed = false;
  }
  reconnect() {
    this.reconnects++;
  }
  ack() {
    this.state = "open";
    this.subscribed = true;
    this.h.onState("open");
    this.h.onSubscribed();
  }
  drop() {
    this.state = "closed";
    this.subscribed = false;
    this.h.onState("closed");
  }
  push(delta: DkDelta) {
    const now = Date.now();
    this.h.onUpdate(delta, { createdTime: new Date(now - 80).toISOString(), publishedTime: new Date(now - 50).toISOString(), wsPublishedTime: new Date(now - 30).toISOString() }, now);
  }
}

const GAME = "34118180";
const priceChange = (american: number) =>
  deltaOf((d) => d.change.selections.push({ id: "0ML84695613_3", displayOdds: odds(american, 1 + american / 100) }));

function setup(fetchSnapshot?: () => Promise<DkSnapshot>) {
  const base = loadSnapshot();
  const fetch = vi.fn(fetchSnapshot ?? (async () => structuredClone(base)));
  let feed!: FakeFeed;
  const hub = new OddsHub({
    fetchSnapshot: fetch,
    createFeed: (h) => (feed = new FakeFeed(h)),
    sink: noopSink,
    now: () => Date.now(),
    instanceId: "test",
  });
  const messages: StreamMessage[] = [];
  const unsubscribe = hub.subscribe((m) => messages.push(m));
  const last = <T extends StreamMessage["type"]>(type: T) => messages.filter((m) => m.type === type).at(-1) as Extract<StreamMessage, { type: T }>;
  return { hub, feed, fetch, messages, last, unsubscribe, base };
}

const awayMoneyline = (games: { id: string; markets: { moneyline?: { selections: { american: number }[] } } }[]) =>
  games.find((g) => g.id === GAME)!.markets.moneyline!.selections[0];

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-22T20:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("OddsHub", () => {
  it("snapshots once subscribed, then streams live moves with timing", async () => {
    const { feed, messages, last } = setup();
    expect(messages[0]).toMatchObject({ type: "status", status: { health: "starting" } });

    feed.ack();
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());
    expect(last("snapshot").games).toHaveLength(32);
    expect(last("snapshot").status.health).toBe("live");

    feed.push(priceChange(250));
    const update = last("update");
    expect(update.moves).toEqual([expect.objectContaining({ gameId: GAME, market: "moneyline", side: "away", source: "ws", from: expect.objectContaining({ american: 235 }), to: expect.objectContaining({ american: 250 }) })]);
    expect(update.timing?.dkCreatedAt).toBeTruthy();
    expect(awayMoneyline(update.games)).toMatchObject({ american: 250, prev: { american: 235 } });
  });

  it("replays updates that land while a snapshot request is in flight", async () => {
    const base = loadSnapshot();
    let release!: (s: DkSnapshot) => void;
    const { feed, hub, last } = setup(() => new Promise((r) => (release = r)));
    feed.ack(); // starts the first snapshot request
    feed.push(priceChange(260)); // arrives before the (older) snapshot comes back
    release(structuredClone(base));
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());
    expect(awayMoneyline(last("snapshot").games).american).toBe(260);
    expect(hub.status().counters.resyncCorrections).toBe(0);
  });

  it("counts and broadcasts drift that a periodic resync finds", async () => {
    const snap = loadSnapshot();
    const { feed, hub, last } = setup(async () => structuredClone(snap));
    feed.ack();
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());

    // DK changed a price and we never got the delta.
    snap.selections.find((s) => s.id === "0ML84695613_3")!.displayOdds = odds(300, 4);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(last("update")).toBeDefined());
    expect(last("update").moves).toEqual([expect.objectContaining({ source: "resync", to: expect.objectContaining({ american: 300 }) })]);
    expect(hub.status().counters.resyncCorrections).toBe(1);
  });

  it("reports DraftKings being unreachable, then recovers", async () => {
    let fail = true;
    const base = loadSnapshot();
    const { hub, last } = setup(async () => {
      if (fail) throw new Error("DraftKings snapshot returned HTTP 503");
      return structuredClone(base);
    });
    await vi.advanceTimersByTimeAsync(3_100); // push feed never comes up; grace timer fetches
    expect(hub.status()).toMatchObject({ health: "down", snapshotError: "DraftKings snapshot returned HTTP 503" });
    expect(last("status").status.health).toBe("down");

    fail = false;
    await vi.advanceTimersByTimeAsync(25_000); // fallback polling with backoff
    expect(last("snapshot").games).toHaveLength(32);
    expect(hub.status().snapshotError).toBeNull();
  });

  it("falls back to polling when the push feed drops, and goes stale if that fails too", async () => {
    let fail = false;
    const base = loadSnapshot();
    const { feed, hub, fetch, last } = setup(async () => {
      if (fail) throw new Error("timed out");
      return structuredClone(base);
    });
    feed.ack();
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());
    feed.drop();
    expect(hub.status().health).toBe("degraded");

    const before = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(21_000);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(before + 2); // ~every 10s
    expect(hub.status().health).toBe("degraded");

    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.status().health).toBe("stale");
    expect(last("status").status.health).toBe("stale");
  });

  it("resyncs when an update references something it doesn't know", async () => {
    const { feed, fetch, hub, last } = setup();
    feed.ack();
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());
    const calls = fetch.mock.calls.length;
    feed.push(deltaOf((d) => d.change.selections.push({ id: "0HC999N300_1", displayOdds: odds(-110, 1.91) })));
    expect(fetch.mock.calls.length).toBe(calls + 1);
    expect(hub.status().counters.unresolved).toBe(1);
  });

  it("measures latency on DraftKings' clock even when ours is off", async () => {
    const { feed, hub, last } = setup();
    // Our clock is 400ms behind DK's; the subscribe round trip took 40ms.
    const now = Date.now();
    feed.state = "open";
    feed.subscribed = true;
    feed.h.onSubscribed({ sentAt: now - 40, receivedAt: now, dkTime: now - 20 + 400 });
    await vi.waitFor(() => expect(last("snapshot")).toBeDefined());
    expect(hub.status().dkClockOffsetMs).toBe(400);

    // DK created a change 80ms ago (its clock) and its socket sent it 30ms ago.
    const dkNow = Date.now() + 400;
    feed.h.onUpdate(priceChange(250), { createdTime: new Date(dkNow - 80).toISOString(), publishedTime: null, wsPublishedTime: new Date(dkNow - 30).toISOString() }, Date.now());
    expect(hub.status().dkToServerMs?.p50).toBe(80);
    expect(hub.status().wireMs?.p50).toBe(30);
    expect(Date.parse(last("update").sentAt)).toBeCloseTo(dkNow, -2);
    expect(hub.now() - Date.now()).toBe(400);
  });

  it("disconnects from DraftKings a minute after the last viewer leaves", async () => {
    const { feed, unsubscribe } = setup();
    feed.ack();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(feed.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(feed.stopped).toBe(1);
  });
});
