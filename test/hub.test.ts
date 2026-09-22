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

const priceChange = (american: number) =>
  deltaOf((d) => d.change.selections.push({ id: "0ML84695613_3", displayOdds: odds(american, 1 + american / 100) }));

function setup(fetchSnapshot?: () => Promise<DkSnapshot>) {
  const base = loadSnapshot();
  const fetch = vi.fn(fetchSnapshot ?? (async () => structuredClone(base)));
  let feed!: FakeFeed;
  const hub = new OddsHub({ fetchSnapshot: fetch, createFeed: (h) => (feed = new FakeFeed(h)), sink: noopSink, now: () => Date.now(), instanceId: "test" });
  const messages: { msg: StreamMessage; frame: string }[] = [];
  const listen = () => hub.subscribe((msg, frame) => messages.push({ msg, frame: new TextDecoder().decode(frame) }));
  const unsubscribe = listen();
  const last = <T extends StreamMessage["type"]>(type: T) => messages.filter((m) => m.msg.type === type).at(-1)?.msg as Extract<StreamMessage, { type: T }>;
  return { hub, feed, fetch, messages, last, unsubscribe, listen };
}

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-22T20:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("OddsHub (push-feed relay)", () => {
  it("relays every DraftKings update to browsers, with DK's timing", () => {
    const { feed, messages, last } = setup();
    expect(messages[0].msg).toMatchObject({ type: "status", status: { health: "starting" } });
    feed.ack();
    expect(last("status").status.health).toBe("live");

    feed.push(priceChange(250));
    const relayed = last("delta");
    expect(relayed.delta.change.selections[0]).toMatchObject({ id: "0ML84695613_3" });
    expect(relayed.timing.dkCreatedAt).toBeTruthy();
    expect(messages.at(-1)!.frame.startsWith("event: delta\ndata: ")).toBe(true);
  });

  it("replays the last few seconds of updates to a browser that just connected", () => {
    const { feed, listen, messages } = setup();
    feed.ack();
    feed.push(priceChange(250));
    vi.advanceTimersByTime(3_000);
    feed.push(priceChange(255));
    vi.advanceTimersByTime(12_000);
    feed.push(priceChange(260)); // the first one is now outside the 10s window

    const before = messages.length;
    listen();
    const joined = messages.slice(before);
    expect(joined[0].msg.type).toBe("status");
    const replays = joined.filter((m) => m.frame.startsWith("event: replay"));
    expect(replays.map((m) => (m.msg as Extract<StreamMessage, { type: "delta" }>).delta.change.selections[0].displayOdds?.american)).toEqual(["+260"]);
  });

  it("keeps relaying when DraftKings blocks the server from the REST board", async () => {
    const { feed, hub, last } = setup(async () => {
      throw new Error("DraftKings snapshot returned HTTP 403 (blocked by Akamai)");
    });
    feed.ack();
    await vi.advanceTimersByTimeAsync(10);
    expect(hub.status()).toMatchObject({ health: "live", serverBoard: { snapshotError: "DraftKings snapshot returned HTTP 403 (blocked by Akamai)" } });
    feed.push(priceChange(250));
    expect(last("delta")).toBeDefined();
  });

  it("keeps a server-side board where the REST board is reachable", async () => {
    const { feed, hub } = setup();
    feed.ack();
    await vi.advanceTimersByTimeAsync(10);
    feed.push(priceChange(250));
    expect(hub.games()).toHaveLength(32);
    expect(hub.status().serverBoard).toMatchObject({ snapshotError: null, moves: 1 });
  });

  it("reports idle when no one is watching (nothing to connect for)", async () => {
    const { hub, unsubscribe } = setup();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(hub.status()).toMatchObject({ health: "idle", ws: "idle" });
  });

  it("reports the push feed reconnecting, then down", async () => {
    const { feed, hub } = setup();
    feed.ack();
    feed.drop();
    expect(hub.status().health).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(hub.status().health).toBe("down");
    feed.ack();
    expect(hub.status().health).toBe("live");
  });

  it("measures latency on DraftKings' clock even when ours is off", async () => {
    const { feed, hub, last } = setup();
    // Our clock is 400ms behind DK's; the subscribe round trip took 40ms.
    const now = Date.now();
    feed.state = "open";
    feed.subscribed = true;
    feed.h.onSubscribed({ sentAt: now - 40, receivedAt: now, dkTime: now - 20 + 400 });
    expect(hub.status().dkClockOffsetMs).toBe(400);

    // DK created a change 80ms ago (its clock) and its socket sent it 30ms ago.
    const dkNow = Date.now() + 400;
    feed.h.onUpdate(priceChange(250), { createdTime: new Date(dkNow - 80).toISOString(), publishedTime: null, wsPublishedTime: new Date(dkNow - 30).toISOString() }, Date.now());
    expect(hub.status().dkToServerMs?.p50).toBe(80);
    expect(hub.status().wireMs?.p50).toBe(30);
    expect(Date.parse(last("delta").sentAt)).toBe(dkNow);
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
