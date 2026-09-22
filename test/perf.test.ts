import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { noopSink } from "@/lib/clickhouse";
import type { Feed, FeedHandlers } from "@/lib/dk/feed";
import { parseWsMessage } from "@/lib/dk/schema";
import { OddsHub } from "@/lib/hub";
import { BoardEngine } from "@/lib/odds/engine";
import { odds, loadSnapshot, updateFrame } from "./helpers";

// Per-update cost of our own code, both halves of the pipeline. Doubles as a budget check.

class IdleFeed implements Feed {
  state = "open" as const;
  subscribed = true;
  constructor(readonly h: FeedHandlers) {}
  start() {}
  stop() {}
  reconnect() {}
}

function percentile(samples: number[], p: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function time(run: (i: number) => void) {
  for (let i = 0; i < 500; i++) run(i); // warm up the JIT
  const samples: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const t0 = performance.now();
    run(i);
    samples.push(performance.now() - t0);
  }
  return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99) };
}

const us = (ms: number) => `${(ms * 1000).toFixed(0)} µs`;

const frames = [200, 210].map((a) =>
  updateFrame(
    { change: { selections: [{ id: "0ML84695613_3", label: "ATL Falcons", displayOdds: odds(a, 1 + a / 100), trueOdds: 1 + a / 100 }] } },
    { createdTime: new Date().toISOString() },
  ),
);

describe("per-update processing cost", () => {
  it("server: raw DK frame -> parsed -> SSE bytes for every viewer (+ its own board)", async () => {
    let feed!: IdleFeed;
    const snapshot = loadSnapshot();
    const hub = new OddsHub({ fetchSnapshot: async () => structuredClone(snapshot), createFeed: (h) => (feed = new IdleFeed(h)), sink: noopSink, now: Date.now, instanceId: "perf" });
    let bytes = 0;
    hub.subscribe((_msg, frame) => (bytes = frame.length));
    feed.h.onSubscribed();
    await new Promise((r) => setTimeout(r, 20)); // server board loads from the fixture

    const t = time((i) => {
      const msg = parseWsMessage(frames[i % 2]);
      if (msg.kind === "update") feed.h.onUpdate(msg.delta, msg.meta, Date.now());
    });
    console.log(`server  frame -> SSE: p50 ${us(t.p50)}, p99 ${us(t.p99)}, ${bytes} bytes`);
    expect(t.p50).toBeLessThan(1);
  });

  it("browser: relayed delta -> board updated (rebuild one game, diff, decorate)", async () => {
    const snapshot = loadSnapshot();
    let changes = 0;
    const engine = new BoardEngine({ fetchSnapshot: async () => structuredClone(snapshot), onChange: () => changes++, now: Date.now });
    await engine.resync();
    const deltas = frames.map((f) => {
      const m = parseWsMessage(f);
      if (m.kind !== "update") throw new Error("bad fixture");
      return m;
    });
    const t = time((i) => engine.apply(deltas[i % 2].delta, deltas[i % 2].meta, Date.now()));
    console.log(`browser delta -> board: p50 ${us(t.p50)}, p99 ${us(t.p99)}`);
    expect(changes).toBeGreaterThan(1000);
    expect(t.p50).toBeLessThan(1);
  });
});
