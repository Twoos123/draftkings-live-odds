import type { BoardStatus, FeedStatus } from "./types";

export type Tone = "live" | "warn" | "error" | "neutral";

export interface Freshness {
  tone: Tone;
  label: string;
  /** Sentence for the banner; null when everything is fine. */
  detail: string | null;
  /** Grey out the odds: we can't vouch for them. */
  dim: boolean;
}

export interface FreshnessInput {
  /** This browser's stream from our server. */
  connection: "connecting" | "open" | "reconnecting";
  /** Browser time we last heard from our server. */
  lastMessageAt: number | null;
  /** Our server's connection to DraftKings' push feed. */
  feed: FeedStatus | null;
  /** The board this browser loaded from DraftKings. */
  board: BoardStatus;
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Everything is on the browser's clock here. */
export function describeFreshness({ connection, lastMessageAt, feed, board }: FreshnessInput, now: number): Freshness {
  if (connection !== "open" && lastMessageAt !== null) {
    const silent = now - lastMessageAt;
    return {
      tone: silent > 15_000 ? "error" : "warn",
      label: "Reconnecting",
      detail: `Lost the connection to our server ${formatAgo(silent)}. Odds may be out of date until it reconnects.`,
      dim: silent > 15_000,
    };
  }

  if (!board.hasData) {
    return board.snapshotError
      ? { tone: "error", label: "Offline", detail: `Couldn't load the odds from DraftKings (${board.snapshotError}). Retrying automatically.`, dim: true }
      : { tone: "neutral", label: "Connecting", detail: null, dim: false };
  }

  if (!feed || feed.health === "starting") {
    return { tone: "neutral", label: "Connecting", detail: "Connecting to DraftKings' live feed…", dim: false };
  }

  if (feed.health === "live") {
    return board.snapshotError
      ? {
          tone: "warn",
          label: "Live",
          detail: `Live updates are flowing, but the periodic full check with DraftKings is failing (${board.snapshotError}).`,
          dim: false,
        }
      : { tone: "live", label: "Live", detail: null, dim: false };
  }

  // Push feed reconnecting or down: the browser falls back to re-checking DraftKings every 10s.
  const checkedAgo = board.lastSnapshotAt === null ? Infinity : now - board.lastSnapshotAt;
  if (!board.snapshotError && checkedAgo <= 30_000) {
    return {
      tone: "warn",
      label: "Delayed",
      detail: `DraftKings' live feed dropped. Re-checking every 10 seconds until it's back (last check ${formatAgo(checkedAgo)}).`,
      dim: false,
    };
  }
  return {
    tone: "error",
    label: "Stale",
    detail: `DraftKings' live feed is down and these odds were last confirmed ${formatAgo(checkedAgo)}, so they may be out of date.${board.snapshotError ? ` (${board.snapshotError})` : ""}`,
    dim: true,
  };
}
