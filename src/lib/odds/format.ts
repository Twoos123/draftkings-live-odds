import type { MarketType, Period, Price } from "./types";

// Odds parsing/formatting. DraftKings renders negative American odds with a
// Unicode minus (U+2212), e.g. "−110", which Number() can't parse.

export function parseAmerican(text: string | undefined | null): number | null {
  if (!text) return null;
  const t = text.replace(/−/g, "-").replace(/\s+/g, "").toUpperCase();
  if (t === "EVEN" || t === "EV") return 100;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}

export function decimalToAmerican(decimal: number): number {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

const MINUS = "−";

export function formatAmerican(american: number): string {
  return american > 0 ? `+${american}` : `${MINUS}${Math.abs(american)}`;
}

export function formatDecimal(decimal: number): string {
  return decimal.toFixed(2);
}

export function formatSpread(line: number): string {
  if (line === 0) return "PK";
  return line > 0 ? `+${line}` : `${MINUS}${Math.abs(line)}`;
}

/** Chance of winning implied by the price (includes the book's margin). */
export function impliedProbability(american: number): number {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

export function formatProbability(american: number): string {
  return `${Math.round(impliedProbability(american) * 1000) / 10}%`;
}

export type OddsFormat = "american" | "decimal";

export function formatOdds(p: { american: number; decimal: number }, format: OddsFormat): string {
  return format === "american" ? formatAmerican(p.american) : formatDecimal(p.decimal);
}

export const PERIOD_LABEL: Record<Period, string> = { full: "Full game", half: "1st half" };

const MARKET_NAME: Record<MarketType, string> = { moneyline: "Moneyline", spread: "Spread", total: "Total" };

/** "Spread" for the full game, "1st-half spread" for the 1st half. */
export function marketLabel(type: MarketType, period: Period): string {
  return period === "half" ? `1st-half ${MARKET_NAME[type].toLowerCase()}` : MARKET_NAME[type];
}

/** Why a game has no lines in a period: DraftKings posts 1st-half lines a few days out and takes them down during the game. */
export function noLinesText(period: Period, started: boolean): string {
  const what = period === "half" ? "1st-half lines" : "lines";
  return started ? `No ${what} right now` : `${what[0].toUpperCase()}${what.slice(1)} not posted yet`;
}

/** A price as one string: "−6.5 −110" (spread), "44.5 −105" (total) or "+235" (moneyline). */
export function formatPrice(market: MarketType, p: Price, format: OddsFormat): string {
  const line = p.line === null ? null : market === "spread" ? formatSpread(p.line) : String(p.line);
  return [line, formatOdds(p, format)].filter(Boolean).join(" ");
}
