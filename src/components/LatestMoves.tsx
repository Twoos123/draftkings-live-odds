"use client";

import { useMemo, useState } from "react";
import { useNow } from "@/hooks/useNow";
import { useRecordedChanges } from "@/hooks/useRecordedChanges";
import { formatPrice, type OddsFormat } from "@/lib/odds/format";
import { formatAgo, formatWhen } from "@/lib/odds/freshness";
import { direction, marketIds, mergeMoves, placeChanges, type LineMove } from "@/lib/odds/history";
import type { Game, MarketType } from "@/lib/odds/types";

const MARKET_LABEL: Record<MarketType, string> = { moneyline: "Moneyline", spread: "Spread", total: "Total" };
const MAX_SHOWN = 6;

function who(g: Game, m: LineMove): string {
  return m.side === "away" ? g.away.short : m.side === "home" ? g.home.short : `${g.away.short}/${g.home.short} ${m.side === "over" ? "Over" : "Under"}`;
}

/**
 * The last few line moves across the board; click one to jump to its game.
 * With line history on, that includes moves recorded before this page opened;
 * otherwise it's moves since then, and it says so. Either way it shows the
 * feed is alive during quiet spells (most DK updates don't move a main line).
 */
export function LatestMoves({
  games,
  moveLog,
  format,
  clockOffsetMs,
  openedAt,
  lastFeedUpdateAt,
  feedSubscribedAt,
  historyOn,
}: {
  games: Map<string, Game>;
  /** Moves seen live since this page opened, newest first. */
  moveLog: LineMove[];
  format: OddsFormat;
  clockOffsetMs: number;
  /** Browser time the page started watching. */
  openedAt: number;
  /** When our server last heard from DraftKings (on DK's clock). */
  lastFeedUpdateAt: string | null;
  /** When our server's DraftKings subscription started (on DK's clock). */
  feedSubscribedAt: string | null;
  /** The server records line history, so earlier moves can be shown too. */
  historyOn: boolean;
}) {
  // Earlier moves are fetched once, for the board as it first loaded; from then on the live feed adds them as they happen.
  const [boardMarkets] = useState(() => marketIds(games.values()).sort());
  const recorded = useRecordedChanges(historyOn ? boardMarkets : null, `moves&limit=${MAX_SHOWN * 4}`);
  const moves = useMemo(
    () =>
      mergeMoves(moveLog, recorded.status === "ready" ? placeChanges(games.values(), recorded.changes) : [])
        .filter((m) => m.from && games.has(m.gameId))
        .slice(0, MAX_SHOWN),
    [games, moveLog, recorded],
  );
  const recordedAny = recorded.status === "ready";
  const browserNow = useNow(5_000);
  const now = browserNow + clockOffsetMs;
  const watchedMin = Math.floor((browserNow - openedAt) / 60_000);
  const quiet = recordedAny
    ? "No line moves recorded for these games yet."
    : watchedMin < 1
      ? "No main lines have moved yet."
      : `No main lines have moved in the ${watchedMin} min you've been watching.`;
  const heartbeat = lastFeedUpdateAt
    ? `DraftKings last sent an update ${formatAgo(now - Date.parse(lastFeedUpdateAt))}`
    : feedSubscribedAt
      ? `Connected to DraftKings' live feed ${formatAgo(now - Date.parse(feedSubscribedAt))}, no updates since`
      : "Connecting to DraftKings' live feed";

  return (
    <section aria-labelledby="latest-moves" className="mt-6 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="latest-moves" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          Latest line moves
        </h2>
        <span className="text-xs text-muted">{recordedAny ? "recorded while anyone has this page open" : "since you opened this page"}</span>
      </div>
      {moves.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          {quiet} {heartbeat}; the feed is live, and a move will appear here the moment it happens. Lines move most around injury news,
          weekends and game time.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {moves.map((m) => {
            const game = games.get(m.gameId)!;
            const up = direction(m.from!, m.to) > 0;
            return (
              <li key={m.key}>
                <a href={`#game-${m.gameId}`} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-cell">
                  <span className={`text-[10px] ${up ? "text-up" : "text-down"}`}>{up ? "▲" : "▼"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{who(game, m)}</span> <span className="text-muted">{MARKET_LABEL[m.market]}</span>
                  </span>
                  <span className="tabular-nums">
                    <s className="text-muted">{formatPrice(m.market, m.from!, format)}</s>
                    <span className="mx-1.5 text-muted">→</span>
                    <span className={`font-semibold ${up ? "text-up" : "text-down"}`}>{formatPrice(m.market, m.to, format)}</span>
                  </span>
                  <span className="hidden w-24 text-right text-xs text-muted sm:inline">{formatWhen(m.at, now)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
