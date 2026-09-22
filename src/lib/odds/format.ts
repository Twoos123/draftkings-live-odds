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
