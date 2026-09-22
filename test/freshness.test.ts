import { describe, expect, it } from "vitest";
import { describeFreshness, formatAgo, type FreshnessInput } from "@/lib/odds/freshness";
import type { BoardStatus, FeedStatus } from "@/lib/odds/types";

const NOW = Date.parse("2026-09-22T20:00:00Z");

function feed(over: Partial<FeedStatus> = {}): FeedStatus {
  return {
    health: "live",
    serverTime: new Date(NOW).toISOString(),
    dkClockOffsetMs: 0,
    instanceId: "t",
    ws: "open",
    subscribed: true,
    subscribedAt: null,
    lastMessageAt: null,
    lastError: null,
    dkToServerMs: null,
    wireMs: null,
    dkInternalMs: null,
    counters: { updates: 0, parseIssues: 0, reconnects: 0 },
    serverBoard: { lastSnapshotAt: null, snapshotError: "DraftKings snapshot returned HTTP 403 (blocked by Akamai)", moves: 0, resyncCorrections: 0 },
    sink: { enabled: false, lastError: null, written: 0 },
    ...over,
  };
}

function board(over: Partial<BoardStatus> = {}): BoardStatus {
  return { hasData: true, lastSnapshotAt: NOW - 20_000, snapshotError: null, counters: { moves: 0, resyncs: 1, resyncCorrections: 0, unresolved: 0 }, ...over };
}

const input = (over: Partial<FreshnessInput> = {}): FreshnessInput => ({ connection: "open", lastMessageAt: NOW, feed: feed(), board: board(), ...over });

describe("describeFreshness", () => {
  it("says nothing extra when live, even though the server itself can't reach the REST board", () => {
    expect(describeFreshness(input(), NOW)).toEqual({ tone: "live", label: "Live", detail: null, dim: false });
  });

  it("explains a board that couldn't be loaded", () => {
    const f = describeFreshness(input({ board: board({ hasData: false, lastSnapshotAt: null, snapshotError: "timed out after 8000ms" }) }), NOW);
    expect(f).toMatchObject({ tone: "error", label: "Offline", dim: true });
    expect(f.detail).toContain("timed out");
  });

  it("warns, then dims, when our own connection goes quiet", () => {
    expect(describeFreshness(input({ connection: "reconnecting", lastMessageAt: NOW - 5_000 }), NOW)).toMatchObject({ tone: "warn", dim: false });
    const lost = describeFreshness(input({ connection: "reconnecting", lastMessageAt: NOW - 30_000 }), NOW);
    expect(lost).toMatchObject({ tone: "error", label: "Reconnecting", dim: true });
    expect(lost.detail).toContain("30s ago");
  });

  it("falls back to 'Delayed' while the push feed is down but checks are recent", () => {
    const f = describeFreshness(input({ feed: feed({ health: "reconnecting", subscribed: false, ws: "closed" }), board: board({ lastSnapshotAt: NOW - 8_000 }) }), NOW);
    expect(f).toMatchObject({ tone: "warn", label: "Delayed", dim: false });
  });

  it("tells the viewer how old stale odds are, and why", () => {
    const f = describeFreshness(
      input({ feed: feed({ health: "down", subscribed: false, ws: "closed" }), board: board({ lastSnapshotAt: NOW - 4 * 60_000, snapshotError: "HTTP 503" }) }),
      NOW,
    );
    expect(f).toMatchObject({ tone: "error", label: "Stale", dim: true });
    expect(f.detail).toContain("4m ago");
    expect(f.detail).toContain("HTTP 503");
  });

  it("stays live but warns when only the periodic check is failing", () => {
    expect(describeFreshness(input({ board: board({ snapshotError: "timed out" }) }), NOW)).toMatchObject({ tone: "warn", label: "Live" });
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
