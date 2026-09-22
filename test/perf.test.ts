import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { noopSink } from "@/lib/clickhouse";
import type { Feed, FeedHandlers } from "@/lib/dk/feed";
import { parseWsMessage } from "@/lib/dk/schema";
import { OddsHub } from "@/lib/hub";
import { odds, loadSnapshot, updateFrame } from "./helpers";

// How long our own code takes per DraftKings update, from the raw websocket
// frame to the serialized SSE message: parse + validate, apply the delta,
// re-normalize, diff, decorate, JSON.stringify. Doubles as a budget check.

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

describe("per-update processing cost", () => {
  it("stays well under a millisecond", async () => {
    let feed!: IdleFeed;
    const snapshot = loadSnapshot();
    const hub = new OddsHub({
      fetchSnapshot: async () => structuredClone(snapshot),
      createFeed: (h) => (feed = new IdleFeed(h)),
      sink: noopSink,
      now: Date.now,
      instanceId: "perf",
    });
    let out = "";
    hub.subscribe((_msg, frame) => {
      out = new TextDecoder().decode(frame);
    });
    await hub.resync();

    const frames = [200, 210].map((a) =>
      updateFrame(
        { change: { selections: [{ id: "0ML84695613_3", label: "ATL Falcons", displayOdds: odds(a, 1 + a / 100), trueOdds: 1 + a / 100 }] } },
        { createdTime: new Date().toISOString() },
      ),
    );
    const run = (i: number) => {
      const msg = parseWsMessage(frames[i % 2]);
      if (msg.kind === "update") feed.h.onUpdate(msg.delta, msg.meta, Date.now());
    };

    for (let i = 0; i < 500; i++) run(i); // warm up the JIT
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t0 = performance.now();
      run(i);
      samples.push(performance.now() - t0);
    }
    const p50 = percentile(samples, 0.5);
    const p99 = percentile(samples, 0.99);
    console.log(`frame → SSE message: p50 ${(p50 * 1000).toFixed(0)} µs, p99 ${(p99 * 1000).toFixed(0)} µs, message ${out.length} bytes`);
    expect(out).toContain("event: update");
    expect(p50).toBeLessThan(1); // ms
  });
});
