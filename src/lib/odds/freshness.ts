import type { FeedStatus } from "./types";

export type Tone = "live" | "warn" | "error" | "neutral";

export interface Freshness {
  tone: Tone;
  label: string;
  /** Sentence for the banner; null when everything is fine. */
  detail: string | null;
  /** Grey out the odds: we can't vouch for them. */
  dim: boolean;
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/**
 * What to tell the viewer about how current the numbers are. `serverNow` is
 * the browser's clock corrected to the server's; `lastMessageAt` is when the
 * browser last heard from our server (browser clock).
 */
export function describeFreshness(
  status: FeedStatus | null,
  connection: "connecting" | "open" | "reconnecting",
  lastMessageAt: number | null,
  now: number,
  serverNow: number,
): Freshness {
  if (connection !== "open" && lastMessageAt !== null) {
    const silent = now - lastMessageAt;
    return {
      tone: silent > 15_000 ? "error" : "warn",
      label: "Reconnecting",
      detail: `Lost the connection to our server ${formatAgo(silent)}. Odds may be out of date until it reconnects.`,
      dim: silent > 15_000,
    };
  }
  if (!status) return { tone: "neutral", label: "Connecting", detail: null, dim: false };

  const age = (iso: string | null) => (iso ? formatAgo(serverNow - Date.parse(iso)) : "never");
  const lastConfirmed = [status.lastSnapshotAt, status.lastMessageAt].filter(Boolean).sort().at(-1) ?? null;

  switch (status.health) {
    case "live":
      return { tone: "live", label: "Live", detail: null, dim: false };
    case "starting":
      return { tone: "neutral", label: "Connecting", detail: "Connecting to DraftKings…", dim: false };
    case "degraded":
      return status.subscribed
        ? {
            tone: "warn",
            label: "Live",
            detail: `Live updates are flowing, but the periodic full check with DraftKings is failing (${status.snapshotError ?? "unknown error"}).`,
            dim: false,
          }
        : {
            tone: "warn",
            label: "Delayed",
            detail: `DraftKings' live feed dropped. Re-checking every 10 seconds until it's back (last check ${age(status.lastSnapshotAt)}).`,
            dim: false,
          };
    case "stale":
      return {
        tone: "error",
        label: "Stale",
        detail: `Can't reach DraftKings. These odds were last confirmed ${age(lastConfirmed)} and may be out of date.${status.snapshotError ? ` (${status.snapshotError})` : ""}`,
        dim: true,
      };
    case "down":
      return {
        tone: "error",
        label: "Offline",
        detail: `Can't reach DraftKings right now${status.snapshotError ? ` (${status.snapshotError})` : ""}. Retrying automatically.`,
        dim: true,
      };
  }
}
