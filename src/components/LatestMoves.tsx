"use client";

import { useMemo } from "react";
import { useNow } from "@/hooks/useNow";
import { formatOdds, formatSpread, type OddsFormat } from "@/lib/odds/format";
import { formatAgo } from "@/lib/odds/freshness";
import type { Game, MarketType, Price, Side } from "@/lib/odds/types";

const MARKET_LABEL: Record<MarketType, string> = { moneyline: "Moneyline", spread: "Spread", total: "Total" };
const MAX_SHOWN = 6;

interface RecentMove {
  key: string;
  gameId: string;
  who: string;
  market: MarketType;
  side: Side;
  from: Price;
  to: Price;
  at: number;
}

function collectMoves(games: Map<string, Game>): RecentMove[] {
  const moves: RecentMove[] = [];
  for (const g of games.values()) {
    for (const m of Object.values(g.markets)) {
      for (const s of m!.selections) {
        if (!s.prev || !s.changedAt) continue;
        const who =
          s.side === "away" ? g.away.short : s.side === "home" ? g.home.short : `${g.away.short}/${g.home.short} ${s.side === "over" ? "Over" : "Under"}`;
        moves.push({ key: `${g.id}:${m!.type}:${s.side}`, gameId: g.id, who, market: m!.type, side: s.side, from: s.prev, to: s, at: Date.parse(s.changedAt) });
      }
    }
  }
  return moves.sort((a, b) => b.at - a.at).slice(0, MAX_SHOWN);
}

function priceText(market: MarketType, p: Price, format: OddsFormat): string {
  const line = p.line === null ? null : market === "spread" ? formatSpread(p.line) : String(p.line);
  return [line, formatOdds(p, format)].filter(Boolean).join(" ");
}

/** The last few line moves across the board; click one to jump to its game. */
export function LatestMoves({ games, format, clockOffsetMs }: { games: Map<string, Game>; format: OddsFormat; clockOffsetMs: number }) {
  const moves = useMemo(() => collectMoves(games), [games]);
  const now = useNow(15_000) + clockOffsetMs;

  return (
    <section aria-labelledby="latest-moves" className="mt-6 rounded-xl border border-border bg-surface px-4 py-3">
      <h2 id="latest-moves" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        Latest line moves
      </h2>
      {moves.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No lines have moved recently. When DraftKings changes a number, it shows up here and flashes in the table below.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {moves.map((m) => {
            const up = m.to.american > m.from.american || (m.to.american === m.from.american && (m.to.line ?? 0) > (m.from.line ?? 0));
            return (
              <li key={m.key}>
                <a href={`#game-${m.gameId}`} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-cell">
                  <span className={`text-[10px] ${up ? "text-up" : "text-down"}`}>{up ? "▲" : "▼"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{m.who}</span> <span className="text-muted">{MARKET_LABEL[m.market]}</span>
                  </span>
                  <span className="tabular-nums">
                    <s className="text-muted">{priceText(m.market, m.from, format)}</s>
                    <span className="mx-1.5 text-muted">→</span>
                    <span className={`font-semibold ${up ? "text-up" : "text-down"}`}>{priceText(m.market, m.to, format)}</span>
                  </span>
                  <span className="hidden w-16 text-right text-xs text-muted sm:inline">{formatAgo(now - m.at)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
