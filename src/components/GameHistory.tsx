"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { useNow } from "@/hooks/useNow";
import { useRecordedChanges } from "@/hooks/useRecordedChanges";
import { formatPrice, type OddsFormat } from "@/lib/odds/format";
import { formatWhen } from "@/lib/odds/freshness";
import { direction, marketIds, mergeMoves, placeChanges, type LineMove } from "@/lib/odds/history";
import type { Game, MarketType } from "@/lib/odds/types";

const MARKETS: [MarketType, string][] = [
  ["spread", "Spread"],
  ["total", "Total"],
  ["moneyline", "Moneyline"],
];
/** Moves seen live since the page opened, newest first. A context, so game cards don't re-render on every move. */
export const MoveLogContext = createContext<LineMove[]>([]);

/** Per market, until "Show all". Live games can move hundreds of times. */
const SHOWN = 8;

function who(game: Game, m: LineMove): string {
  return m.side === "away" ? game.away.short : m.side === "home" ? game.home.short : m.side === "over" ? "Over" : "Under";
}

function MarketMoves({ game, label, moves, format, now }: { game: Game; label: string; moves: LineMove[]; format: OddsFormat; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? moves : moves.slice(0, SHOWN);
  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</h3>
      <ul className="mt-1 space-y-0.5">
        {shown.map((m) => {
          const dir = m.from ? direction(m.from, m.to) : 0;
          return (
            <li key={m.key} className="flex items-baseline gap-2 tabular-nums sm:gap-3">
              <span className="w-[4.5rem] shrink-0 text-xs text-muted sm:w-24">{formatWhen(m.at, now)}</span>
              <span className="w-12 shrink-0 truncate font-medium sm:w-14">{who(game, m)}</span>
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {m.from ? (
                  <s className="text-muted">{formatPrice(m.market, m.from, format)}</s>
                ) : (
                  <span className="text-muted" title="The price before this wasn't recorded (no one had the page open)">
                    ?
                  </span>
                )}
                <span className="mx-1 text-muted sm:mx-1.5">→</span>
                <span className={`font-semibold ${dir > 0 ? "text-up" : dir < 0 ? "text-down" : ""}`}>{formatPrice(m.market, m.to, format)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {moves.length > SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-xs text-muted underline hover:text-foreground">
          {all ? "Show fewer" : `Show all ${moves.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Every recorded line move for one game, newest first, plus those seen live
 * on this page (the latest may not have reached the database yet).
 */
export function GameHistory({ game, format }: { game: Game; format: OddsFormat }) {
  // Fetched once when opened; moves after that arrive through the live feed.
  const [markets] = useState(() => marketIds([game]));
  const recorded = useRecordedChanges(markets);
  const moveLog = useContext(MoveLogContext);
  const now = useNow(30_000);
  const moves = useMemo(
    () =>
      mergeMoves(
        moveLog.filter((m) => m.gameId === game.id),
        recorded.status === "ready" ? placeChanges([game], recorded.changes) : [],
      ),
    [game, moveLog, recorded],
  );

  let body;
  if (recorded.status === "loading" && moves.length === 0) body = <p className="text-muted">Loading line history…</p>;
  else if (recorded.status === "error") body = <p className="text-muted">Couldn&apos;t load line history: {recorded.message}</p>;
  else if (moves.length === 0) body = <p className="text-muted">No line moves recorded for this game yet.</p>;
  else {
    body = (
      <div className="space-y-3">
        {MARKETS.map(([type, label]) => {
          const list = moves.filter((m) => m.market === type);
          return list.length ? <MarketMoves key={type} game={game} label={label} moves={list} format={format} now={now} /> : null;
        })}
      </div>
    );
  }

  return (
    <div className="mt-2.5 rounded-lg border border-border px-3 py-2.5 text-sm">
      {body}
      <p className="mt-2 text-xs text-muted">
        {recorded.status === "off"
          ? "Showing moves since you opened this page. Line history isn't recorded on this deployment."
          : "Recorded from DraftKings' live feed while anyone has this page open, so moves at other times can be missing."}
      </p>
    </div>
  );
}
