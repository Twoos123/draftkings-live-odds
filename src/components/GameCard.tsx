"use client";

import { memo, useState } from "react";
import { noLinesText, type OddsFormat } from "@/lib/odds/format";
import type { Game, Period, Team } from "@/lib/odds/types";
import { GameHistory } from "./GameHistory";
import { PriceCell } from "./PriceCell";

// Phones: the team column keeps room for "● @ WAS" and the price columns give way (down to ~60px on a 320px screen).
export const GRID =
  "grid grid-cols-[minmax(4.5rem,1fr)_repeat(3,minmax(0,5.25rem))] gap-x-1 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,7rem))] sm:gap-x-2";

function TeamName({ team, home }: { team: Team; home: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 pr-1 sm:gap-2 sm:pr-2">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/15 sm:h-2.5 sm:w-2.5 dark:ring-white/25"
        style={{ backgroundColor: team.color ?? "var(--muted)" }}
      />
      {home && (
        <span className="-mr-1 text-xs text-muted" title="Home team">
          @
        </span>
      )}
      <span className="truncate font-medium sm:hidden">{team.short}</span>
      <span className="hidden truncate font-medium sm:inline">{team.name}</span>
    </div>
  );
}

/**
 * One game, for the period picked in the toolbar: away team on top, home team
 * below (the usual US convention). Memoized: an update to one game leaves
 * every other card untouched.
 */
export const GameCard = memo(function GameCard({ game, period, format, clockOffsetMs }: { game: Game; period: Period; format: OddsFormat; clockOffsetMs: number }) {
  const { moneyline, spread, total } = game.markets[period];
  const started = game.status !== "NOT_STARTED";
  const paused = [moneyline, spread, total].some((m) => m?.suspended);
  const noLines = !moneyline && !spread && !total;
  const kickoff = new Date(game.startTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div id={`game-${game.id}`} className="game-card scroll-mt-36 border-b border-border px-2.5 py-2.5 last:border-b-0 sm:scroll-mt-28 sm:px-4">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        {started ? (
          <span className="shrink-0 rounded bg-danger px-1.5 py-px text-[10px] font-bold tracking-wider text-white">LIVE</span>
        ) : (
          <time className="shrink-0" dateTime={game.startTime}>
            {kickoff}
          </time>
        )}
        {paused && <span className="truncate">· Betting paused on some markets</span>}
        <button
          type="button"
          onClick={() => setHistoryOpen(!historyOpen)}
          aria-expanded={historyOpen}
          aria-controls={`history-${game.id}`}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 hover:text-foreground"
        >
          Line history
          <svg className={`h-3 w-3 transition-transform ${historyOpen ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className={`${GRID} gap-y-1.5`}>
        {(
          [
            [game.away, "away", "over"],
            [game.home, "home", "under"],
          ] as const
        ).map(([team, side, totalSide], row) =>
          noLines ? (
            <div key={side} className="col-start-1 flex min-h-12 min-w-0 items-center" style={{ gridRow: row + 1 }}>
              <TeamName team={team} home={side === "home"} />
            </div>
          ) : (
            <div key={side} className="contents">
              <TeamName team={team} home={side === "home"} />
              <PriceCell market={spread} side={side} format={format} clockOffsetMs={clockOffsetMs} />
              <PriceCell market={total} side={totalSide} format={format} clockOffsetMs={clockOffsetMs} />
              <PriceCell market={moneyline} side={side} format={format} clockOffsetMs={clockOffsetMs} />
            </div>
          ),
        )}
        {noLines && (
          // One note across the price columns instead of six dashes: room to say why, even on a phone.
          <div className="col-span-3 col-start-2 row-span-2 row-start-1 flex items-center justify-center rounded-md bg-cell px-2 text-center text-xs text-muted">
            {noLinesText(period, started)}
          </div>
        )}
      </div>
      {historyOpen && (
        <div id={`history-${game.id}`}>
          {/* Keyed by period: its market list is fixed when it opens, so a switch starts it afresh. */}
          <GameHistory key={period} game={game} period={period} format={format} />
        </div>
      )}
    </div>
  );
});
