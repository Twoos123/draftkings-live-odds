"use client";

import { memo, useEffect, useState } from "react";
import { formatOdds, formatProbability, formatSpread, type OddsFormat } from "@/lib/odds/format";
import type { Market, Price, Selection, Side } from "@/lib/odds/types";

/** Keep showing the old price beside the new one for this long. */
const SHOW_PREVIOUS_MS = 10 * 60_000;
/** Background flash after a move. Matches the CSS animation. */
const FLASH_MS = 4_000;

function lineText(market: Market, line: number | null, side: Side): string | null {
  if (line === null) return null;
  if (market.type === "spread") return formatSpread(line);
  if (market.type === "total") return `${side === "over" ? "O" : "U"} ${line}`;
  return null;
}

/** +1 if the price/line went up, -1 if down. */
function direction(prev: Price, sel: Selection): number {
  if (prev.american !== sel.american) return Math.sign(sel.american - prev.american);
  return Math.sign((sel.line ?? 0) - (prev.line ?? 0));
}

interface CellProps {
  market: Market | undefined;
  side: Side;
  format: OddsFormat;
  /** Server clock minus browser clock, for timing how long ago a move happened. */
  clockOffsetMs: number;
}

/**
 * One price. Cells that never moved render once and stay put; only cells with
 * a recent move run a clock (to fade the highlight and drop the old price).
 */
export const PriceCell = memo(function PriceCell({ market, side, format, clockOffsetMs }: CellProps) {
  const sel = market?.selections.find((s) => s.side === side);
  if (!market || !sel) {
    return <div className="flex min-h-12 items-center justify-center rounded-md bg-cell text-muted">—</div>;
  }
  if (sel.prev && sel.changedAt) {
    // Keyed by the move, so a new move starts a fresh timer.
    return <MovedPrice key={sel.changedAt} market={market} sel={sel} side={side} format={format} clockOffsetMs={clockOffsetMs} />;
  }
  return <PriceBox market={market} sel={sel} side={side} format={format} />;
});

/**
 * How long ago a move happened, re-rendering only when that crosses a
 * threshold (flash over, old price dropped) rather than every second.
 */
function useMoveAge(changedAt: number, clockOffsetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  const age = now + clockOffsetMs - changedAt;
  useEffect(() => {
    const next = [FLASH_MS, SHOW_PREVIOUS_MS].find((threshold) => threshold > age);
    if (next === undefined) return;
    const t = setTimeout(() => setNow(Date.now()), next - age + 50);
    return () => clearTimeout(t);
  }, [age]);
  return age;
}

function MovedPrice({ market, sel, side, format, clockOffsetMs }: { market: Market; sel: Selection; side: Side; format: OddsFormat; clockOffsetMs: number }) {
  const age = useMoveAge(Date.parse(sel.changedAt!), clockOffsetMs);
  if (age >= SHOW_PREVIOUS_MS) return <PriceBox market={market} sel={sel} side={side} format={format} />;
  const dir = direction(sel.prev!, sel);
  return <PriceBox market={market} sel={sel} side={side} format={format} prev={sel.prev} dir={dir} flash={dir !== 0 && age < FLASH_MS} />;
}

function PriceBox({
  market,
  sel,
  side,
  format,
  prev,
  dir = 0,
  flash = false,
}: {
  market: Market;
  sel: Selection;
  side: Side;
  format: OddsFormat;
  prev?: Price;
  dir?: number;
  flash?: boolean;
}) {
  const line = lineText(market, sel.line, side);
  const prevLine = prev && prev.line !== sel.line ? lineText(market, prev.line, side) : null;
  const prevOdds = prev && prev.american !== sel.american ? formatOdds(prev, format) : null;
  const odds = formatOdds(sel, format);
  const priceText = (p: Price) => [lineText(market, p.line, side), formatOdds(p, format)].filter(Boolean).join(" ");
  const title = [
    `${sel.label} ${priceText(sel)}`,
    `Implied chance: ${formatProbability(sel.american)}`,
    prev && `Was ${priceText(prev)}`,
    market.suspended && "Betting paused by DraftKings",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      key={`${sel.line}|${sel.american}`}
      title={title}
      className={`relative flex min-h-12 flex-col items-center justify-center rounded-md bg-cell px-1.5 py-1 text-center tabular-nums leading-tight ${flash ? (dir > 0 ? "flash-up" : "flash-down") : ""} ${market.suspended ? "opacity-45" : ""}`}
    >
      {line && (
        <div className="text-[13px] font-medium">
          {prevLine && <s className="mr-1 text-[11px] font-normal text-muted">{prevLine}</s>}
          {line}
        </div>
      )}
      <div className={`flex items-center gap-1 ${line ? "text-[12px] text-muted" : "text-[14px] font-semibold"}`}>
        {prevOdds && <s className="text-[11px] font-normal text-muted">{prevOdds}</s>}
        <span className={dir > 0 ? "text-up" : dir < 0 ? "text-down" : line ? "" : "text-foreground"}>{odds}</span>
        {dir !== 0 && (
          <span aria-label={dir > 0 ? "moved up" : "moved down"} className={`text-[9px] ${dir > 0 ? "text-up" : "text-down"}`}>
            {dir > 0 ? "▲" : "▼"}
          </span>
        )}
      </div>
      {market.suspended && (
        <svg aria-label="Betting paused" className="absolute right-1 top-1 h-3 w-3 text-muted" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 1 0-3 0v2Z" />
        </svg>
      )}
    </div>
  );
}
