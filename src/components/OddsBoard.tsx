"use client";

import { useMemo, useState } from "react";
import { useNow } from "@/hooks/useNow";
import { useOddsFormat } from "@/hooks/useOddsFormat";
import { useOddsStream, type ClientLatency } from "@/hooks/useOddsStream";
import type { OddsFormat } from "@/lib/odds/format";
import { describeFreshness, formatAgo, type Freshness, type Tone } from "@/lib/odds/freshness";
import type { BoardStatus, FeedStatus, Game, LatencyStats } from "@/lib/odds/types";
import { FeedDetails } from "./FeedDetails";
import { GameCard, GRID } from "./GameCard";
import { HowToRead } from "./HowToRead";
import { LatestMoves } from "./LatestMoves";

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/Twoos123/draftkings-live-odds";

const TONE_DOT: Record<Tone, string> = { live: "bg-live", warn: "bg-warn", error: "bg-danger", neutral: "bg-muted" };
const TONE_BANNER: Record<Tone, string> = {
  live: "",
  warn: "border-warn/40 bg-warn/10",
  error: "border-danger/40 bg-danger/10",
  neutral: "border-border bg-surface",
};

function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupByDay(games: Game[], today: Date): { key: string; label: string; games: Game[] }[] {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const groups: { key: string; label: string; games: Game[] }[] = [];
  for (const g of games) {
    const start = new Date(g.startTime);
    const key = dayKey(start);
    if (groups.at(-1)?.key === key) {
      groups.at(-1)!.games.push(g);
      continue;
    }
    const prefix = key === dayKey(today) ? "Today · " : key === dayKey(tomorrow) ? "Tomorrow · " : "";
    groups.push({ key, label: prefix + fmt.format(start), games: [g] });
  }
  return groups;
}

function matches(g: Game, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [g.away.name, g.away.short, g.home.name, g.home.short].some((s) => s.toLowerCase().includes(q));
}

const MIN_SAMPLES = 3;

function seconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "≈0.2 s behind DraftKings": measured end to end once updates arrive, else DK→server + server→you. */
function LatencyBadge({ latency, feed }: { latency: ClientLatency; feed: FeedStatus | null }) {
  const dk = feed?.dkToServerMs;
  const hop = latency.serverToBrowser;
  // A median of one or two updates is noise (DraftKings sometimes holds a change for seconds).
  const enough = (s: LatencyStats | null | undefined) => (s && s.n >= MIN_SAMPLES ? s : null);
  const e2e = enough(latency.endToEnd);
  const server = enough(dk);
  // Until the browser has timed enough updates itself, DK → server + server → you is the estimate.
  const total = e2e ? e2e.p50 : server ? server.p50 + (hop?.p50 ?? 0) : null;
  if (total === null || total < 0) return null;
  const title = [
    latency.endToEnd && `DraftKings → your screen: ${latency.endToEnd.p50} ms median over ${latency.endToEnd.n} moves`,
    dk && `DraftKings → our server: ${dk.p50} ms median (${dk.n} updates)`,
    hop && `Our server → you: ${hop.p50} ms median`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted">
      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M9.5 1 3 9h4.5L6.5 15 13 7H8.5l1-6Z" />
      </svg>
      ≈{seconds(total)} behind<span className="hidden sm:inline"> DraftKings</span>
    </span>
  );
}

function StatusPill({ fresh, board, now }: { fresh: Freshness; board: BoardStatus; now: number }) {
  const checked = board.lastSnapshotAt !== null ? `Last full check with DraftKings ${formatAgo(now - board.lastSnapshotAt)}` : null;
  const title = fresh.tone === "live" ? ["Connected to DraftKings' live feed. Prices update the moment a line moves.", checked].filter(Boolean).join("\n") : (fresh.detail ?? "");
  return (
    <span title={title} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium" aria-live="polite">
      <span className={`h-2 w-2 rounded-full ${TONE_DOT[fresh.tone]} ${fresh.tone === "live" ? "animate-pulse" : ""}`} />
      {fresh.label}
    </span>
  );
}

function FormatToggle({ format, onChange }: { format: OddsFormat; onChange: (f: OddsFormat) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-full border border-border bg-surface p-0.5 text-sm" role="group" aria-label="Odds format">
      {(["american", "decimal"] as const).map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          aria-pressed={format === f}
          className={`rounded-full px-3 py-1 capitalize transition-colors ${format === f ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}
        >
          {f}
        </button>
      ))}
    </div>
  );
}

export function OddsBoard() {
  const { games, feed, board, connection, lastMessageAt, latency, refresh, refreshing, clockOffsetMs } = useOddsStream();
  const [format, setFormat] = useOddsFormat();
  const [query, setQuery] = useState("");
  const now = useNow();
  const serverNow = now + clockOffsetMs;
  const today = new Date(now);
  const todayKey = dayKey(today);

  const sorted = useMemo(
    () => [...games.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name)),
    [games],
  );
  const groups = useMemo(
    () => groupByDay(sorted.filter((g) => matches(g, query)), new Date(now)),
    // `now` only matters when the date rolls over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, query, todayKey],
  );
  const fresh = describeFreshness({ connection, lastMessageAt, feed, board }, now);
  const loading = !board.hasData && !board.snapshotError;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-12 sm:px-6">
      <header className="pt-8 sm:pt-12">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">DraftKings · NFL</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">NFL odds, live</h1>
        <p className="mt-2 max-w-prose text-sm text-muted sm:text-base">
          Moneyline, spread and total for every upcoming game, straight from DraftKings. Prices update on their own the moment a line moves, so
          there&apos;s no need to refresh.
        </p>
      </header>

      <div className="sticky top-0 z-20 -mx-4 mt-5 border-b border-border bg-background/85 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill fresh={fresh} board={board} now={now} />
          <LatencyBadge latency={latency} feed={feed} />
          {/* Phones: status + Refresh on one row, search + format below. Wider: one row. */}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh: re-check every line with DraftKings now"
            title="Re-check every line with DraftKings now"
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-cell disabled:opacity-60 sm:order-last sm:ml-0"
          >
            <svg className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5v3h-3" />
            </svg>
            <span>{refreshing ? "Checking…" : "Refresh"}</span>
          </button>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
              <span className="sr-only">Search teams</span>
              <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3 3" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search teams"
                className="w-full rounded-full border border-border bg-surface py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-muted focus:border-foreground/40"
              />
            </label>
            <FormatToggle format={format} onChange={setFormat} />
          </div>
        </div>
        {fresh.detail && (
          <div role="status" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${TONE_BANNER[fresh.tone]}`}>
            {fresh.detail}
          </div>
        )}
      </div>

      {games.size > 0 && <LatestMoves games={games} format={format} clockOffsetMs={clockOffsetMs} />}
      <HowToRead />

      <div className={`transition-opacity ${fresh.dim ? "opacity-50 grayscale" : ""}`}>
        {loading && <LoadingBoard />}
        {!loading && games.size === 0 && (
          <p className="mt-8 rounded-xl border border-border bg-surface px-4 py-8 text-center text-muted">
            {board.hasData ? "DraftKings has no upcoming NFL games listed right now." : "No odds to show yet. We'll load them as soon as DraftKings responds."}
          </p>
        )}
        {games.size > 0 && groups.length === 0 && (
          <p className="mt-8 rounded-xl border border-border bg-surface px-4 py-8 text-center text-muted">
            No games match “{query}”.{" "}
            <button type="button" className="underline" onClick={() => setQuery("")}>
              Show all games
            </button>
          </p>
        )}
        {groups.map(({ key, label, games: dayGames }) => (
          <section key={key} className="mt-8">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              {label} <span className="font-normal normal-case tracking-normal">· {dayGames.length} {dayGames.length === 1 ? "game" : "games"}</span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className={`${GRID} border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted sm:px-4`}>
                <span>Game</span>
                <span className="text-center">Spread</span>
                <span className="text-center">Total</span>
                <span className="text-center">Moneyline</span>
              </div>
              {dayGames.map((g) => (
                <GameCard key={g.id} game={g} format={format} clockOffsetMs={clockOffsetMs} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <FeedDetails feed={feed} board={board} latency={latency} now={now} serverNow={serverNow} />

      <footer className="mt-6 text-xs leading-relaxed text-muted">
        Odds from DraftKings Sportsbook (New Jersey), pushed from DraftKings&apos; live feed and fully re-checked every minute. Main markets only. Not
        affiliated with DraftKings.{" "}
        <a className="underline" href={REPO_URL}>
          Source code
        </a>
        .
      </footer>
    </main>
  );
}

function LoadingBoard() {
  return (
    <div className="mt-8 space-y-3" aria-label="Loading odds">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-surface" />
      ))}
    </div>
  );
}
