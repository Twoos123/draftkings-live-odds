"use client";

import { memo } from "react";
import type { OddsFormat } from "@/lib/odds/format";
import type { Game, Team } from "@/lib/odds/types";
import { PriceCell } from "./PriceCell";

export const GRID =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,5.25rem))] gap-x-1.5 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,7rem))] sm:gap-x-2";

function TeamName({ team, home }: { team: Team; home: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 pr-2">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 dark:ring-white/25"
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
 * One game: away team on top, home team below (the usual US convention).
 * Memoized: an update to one game leaves every other card untouched.
 */
export const GameCard = memo(function GameCard({ game, format, clockOffsetMs }: { game: Game; format: OddsFormat; clockOffsetMs: number }) {
  const { moneyline, spread, total } = game.markets;
  const started = game.status !== "NOT_STARTED";
  const paused = [moneyline, spread, total].some((m) => m?.suspended);
  const kickoff = new Date(game.startTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div id={`game-${game.id}`} className="game-card scroll-mt-28 border-b border-border px-3 py-2.5 last:border-b-0 sm:px-4">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        {started ? (
          <span className="rounded bg-danger px-1.5 py-px text-[10px] font-bold tracking-wider text-white">LIVE</span>
        ) : (
          <time dateTime={game.startTime}>{kickoff}</time>
        )}
        {paused && <span>· Betting paused on some markets</span>}
      </div>
      <div className={`${GRID} gap-y-1.5`}>
        {(
          [
            [game.away, "away", "over"],
            [game.home, "home", "under"],
          ] as const
        ).map(([team, side, totalSide]) => (
          <div key={side} className="contents">
            <TeamName team={team} home={side === "home"} />
            <PriceCell market={spread} side={side} format={format} clockOffsetMs={clockOffsetMs} />
            <PriceCell market={total} side={totalSide} format={format} clockOffsetMs={clockOffsetMs} />
            <PriceCell market={moneyline} side={side} format={format} clockOffsetMs={clockOffsetMs} />
          </div>
        ))}
      </div>
    </div>
  );
});
