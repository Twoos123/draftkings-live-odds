import { describe, expect, it } from "vitest";
import { describeFreshness, formatAgo } from "@/lib/odds/freshness";
import type { FeedStatus } from "@/lib/odds/types";

const NOW = Date.parse("2026-09-22T20:00:00Z");

function status(over: Partial<FeedStatus>): FeedStatus {
  return {
    health: "live",
    serverTime: new Date(NOW).toISOString(),
    dkClockOffsetMs: 0,
    instanceId: "t",
    ws: "open",
    subscribed: true,
    lastMessageAt: null,
    lastSnapshotAt: new Date(NOW - 20_000).toISOString(),
    snapshotError: null,
    lastError: null,
    dkToServerMs: null,
    wireMs: null,
    counters: { updates: 0, moves: 0, resyncs: 1, resyncCorrections: 0, unresolved: 0, parseIssues: 0, reconnects: 0 },
    sink: { enabled: false, lastError: null, written: 0 },
    ...over,
  };
}

describe("describeFreshness", () => {
  it("says nothing extra when live", () => {
    expect(describeFreshness(status({}), "open", NOW, NOW, NOW)).toEqual({ tone: "live", label: "Live", detail: null, dim: false });
  });

  it("warns, then dims, when our own connection goes quiet", () => {
    expect(describeFreshness(status({}), "reconnecting", NOW - 5_000, NOW, NOW)).toMatchObject({ tone: "warn", dim: false });
    const lost = describeFreshness(status({}), "reconnecting", NOW - 30_000, NOW, NOW);
    expect(lost).toMatchObject({ tone: "error", label: "Reconnecting", dim: true });
    expect(lost.detail).toContain("30s ago");
  });

  it("tells the viewer how old stale odds are, and why", () => {
    const f = describeFreshness(
      status({ health: "stale", ws: "closed", subscribed: false, lastSnapshotAt: new Date(NOW - 4 * 60_000).toISOString(), snapshotError: "HTTP 503" }),
      "open",
      NOW,
      NOW,
      NOW,
    );
    expect(f).toMatchObject({ tone: "error", label: "Stale", dim: true });
    expect(f.detail).toContain("4m ago");
    expect(f.detail).toContain("HTTP 503");
  });

  it("distinguishes a dropped push feed from failing REST checks", () => {
    expect(describeFreshness(status({ health: "degraded", subscribed: false, ws: "closed" }), "open", NOW, NOW, NOW).label).toBe("Delayed");
    expect(describeFreshness(status({ health: "degraded", snapshotError: "timed out" }), "open", NOW, NOW, NOW).detail).toContain("timed out");
  });
});

describe("formatAgo", () => {
  it("reads naturally", () => {
    expect(formatAgo(2_000)).toBe("just now");
    expect(formatAgo(42_000)).toBe("42s ago");
    expect(formatAgo(125_000)).toBe("2m ago");
    expect(formatAgo(3_725_000)).toBe("1h 2m ago");
  });
});
