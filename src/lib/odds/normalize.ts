import type { DkEvent, DkMarket, DkSelection } from "../dk/schema";
import { americanToDecimal, decimalToAmerican, parseAmerican } from "./format";
import type { DkStore } from "./store";
import { PERIODS, type Game, type Market, type MarketType, type Move, type MoveSource, type Period, type Price, type PriceMove, type Selection, type Side, type Team } from "./types";

const MARKET_ORDER: readonly MarketType[] = ["moneyline", "spread", "total"];
/** DK's market type names ("Spread", "Spread 1st Half"), lowercased. Anything else isn't on the board. */
const MARKET_KINDS: Record<string, [Period, MarketType]> = Object.fromEntries(
  MARKET_ORDER.flatMap((type) => [
    [type, ["full", type]],
    [`${type} 1st half`, ["half", type]],
  ]),
);
const SIDE_ORDER: Record<Side, number> = { away: 0, over: 0, home: 1, under: 1 };

function marketKindOf(m: DkMarket): [Period, MarketType] | null {
  const name = (m.marketType?.name ?? m.name ?? "").trim().toLowerCase();
  return MARKET_KINDS[name] ?? null;
}

export function emptyMarkets(): Game["markets"] {
  return { full: {}, half: {} };
}

/** Every market on a game, full game then 1st half. */
export function allMarkets(game: Game): Market[] {
  return PERIODS.flatMap((p) => MARKET_ORDER.flatMap((t) => game.markets[p][t] ?? []));
}

function sideOf(s: DkSelection): Side | null {
  const t = (s.outcomeType ?? "").toLowerCase();
  return t === "away" || t === "home" || t === "over" || t === "under" ? t : null;
}

/** A selection's odds in both formats, from whichever of DK's fields it carries. */
export function oddsOf(s: DkSelection): Omit<Price, "line"> | null {
  const parsedDecimal = s.displayOdds?.decimal ? Number(s.displayOdds.decimal) : NaN;
  const american = parseAmerican(s.displayOdds?.american);
  const decimal =
    Number.isFinite(parsedDecimal) && parsedDecimal > 1
      ? parsedDecimal
      : s.trueOdds && s.trueOdds > 1
        ? Math.round(s.trueOdds * 100) / 100
        : american !== null
          ? Math.round(americanToDecimal(american) * 100) / 100
          : null;
  if (decimal === null) return null;
  return { american: american ?? decimalToAmerican(decimal), decimal };
}

function priceOf(s: DkSelection, type: MarketType): Price | null {
  const odds = oddsOf(s);
  if (!odds) return null;
  const line = type === "moneyline" ? null : (s.points ?? null);
  if (type !== "moneyline" && line === null) return null;
  return { line, ...odds };
}

function team(e: DkEvent, role: "Home" | "Away"): Team | null {
  const p = e.participants?.find((x) => x.venueRole === role);
  if (p) {
    const color = p.metadata?.teamColor;
    return { id: p.id, name: p.name, short: p.metadata?.shortName ?? p.name, ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) };
  }
  // Fall back to the event name, "ATL Falcons @ GB Packers".
  const parts = e.name?.split(" @ ");
  if (parts?.length !== 2) return null;
  const name = role === "Away" ? parts[0] : parts[1];
  return { id: `${e.id}:${role}`, name, short: name.split(" ")[0] };
}

function normalizeMarket(store: DkStore, m: DkMarket): Market | null {
  const kind = marketKindOf(m);
  if (!kind) return null;
  const [period, type] = kind;
  const bySide = new Map<Side, Selection & { main: boolean }>();
  for (const s of store.selectionsOf(m.id)) {
    const side = sideOf(s);
    const price = side && priceOf(s, type);
    if (!side || !price) continue;
    const candidate = { id: s.id, side, label: s.label ?? side, ...price, main: s.tags?.includes("MainPointLine") ?? false };
    const existing = bySide.get(side);
    // If DK ever sends more than one line per side, prefer the main line.
    if (!existing || (candidate.main && !existing.main)) bySide.set(side, candidate);
  }
  // No priced sides is kept: DK can remove a market's old line an update or two before adding the new one.
  const selections: Selection[] = [...bySide.values()]
    .sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side])
    .map((c) => ({ id: c.id, side: c.side, label: c.label, line: c.line, american: c.american, decimal: c.decimal }));
  return { id: m.id, type, period, suspended: m.isSuspended ?? false, selections };
}

/** One game from DK's entity graph. Cost depends on this game only, not the board size. */
export function normalizeGame(store: DkStore, eventId: string): Game | null {
  const e = store.events.get(eventId);
  if (!e) return null;
  const away = team(e, "Away");
  const home = team(e, "Home");
  if (!away || !home || !e.startEventDate) return null;
  const found = emptyMarkets();
  for (const m of store.marketsOf(eventId)) {
    const market = normalizeMarket(store, m);
    const existing = market && found[market.period][market.type];
    if (market && (!existing || (!existing.selections.length && market.selections.length))) found[market.period][market.type] = market;
  }
  // Same key order however the markets arrived, so diffGames' JSON compare sees no false changes.
  const markets = emptyMarkets();
  for (const p of PERIODS) {
    for (const t of MARKET_ORDER) {
      const m = found[p][t];
      if (m) markets[p][t] = m;
    }
  }
  return {
    id: e.id,
    name: e.name ?? `${away.name} @ ${home.name}`,
    startTime: e.startEventDate,
    status: e.status ?? "NOT_STARTED",
    away,
    home,
    markets,
  };
}

/** DK's entity graph -> our game/market/side/line/odds shape, for the whole board. */
export function normalizeGames(store: DkStore): Map<string, Game> {
  const games = new Map<string, Game>();
  for (const id of store.events.keys()) {
    const game = normalizeGame(store, id);
    if (game) games.set(id, game);
  }
  return games;
}

export function sortGames(games: Iterable<Game>): Game[] {
  return [...games].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
}

export function sideKey(gameId: string, period: Period, market: MarketType, side: Side): string {
  return `${gameId}:${period}:${market}:${side}`;
}

export interface GamesDiff {
  changed: string[];
  removed: string[];
  moves: PriceMove[];
}

function priceMoves(before: Game, after: Game, lastPrices?: ReadonlyMap<string, Price>): PriceMove[] {
  const moves: PriceMove[] = [];
  for (const period of PERIODS) {
    for (const type of MARKET_ORDER) {
      const oldSels = before.markets[period][type]?.selections ?? [];
      for (const sel of after.markets[period][type]?.selections ?? []) {
        const old = oldSels.find((s) => s.side === sel.side) ?? lastPrices?.get(sideKey(after.id, period, type, sel.side));
        if (!old || (old.american === sel.american && old.line === sel.line)) continue;
        moves.push({
          gameId: after.id,
          period,
          market: type,
          side: sel.side,
          selectionId: sel.id,
          from: { line: old.line, american: old.american, decimal: old.decimal },
          to: { line: sel.line, american: sel.american, decimal: sel.decimal },
        });
      }
    }
  }
  return moves;
}

export interface DiffOptions {
  /** Compare only these games (the ones an update touched); otherwise every game in either board. */
  ids?: Iterable<string>;
  /**
   * Each side's last known price, by sideKey, for sides missing from `prev`.
   * DraftKings can send a line move as "remove the old line", then "add the
   * new one" in a later update, so the new line arrives with nothing in
   * `prev` to compare it with.
   */
  lastPrices?: ReadonlyMap<string, Price>;
}

/** What changed between two versions of the board. Line or price changes are "moves". */
export function diffGames(prev: Map<string, Game>, next: Map<string, Game>, { ids, lastPrices }: DiffOptions = {}): GamesDiff {
  const changed: string[] = [];
  const removed: string[] = [];
  const moves: PriceMove[] = [];
  for (const id of ids ?? new Set([...prev.keys(), ...next.keys()])) {
    const before = prev.get(id);
    const after = next.get(id);
    if (!after) {
      if (before) removed.push(id);
      continue;
    }
    if (!before) {
      changed.push(id);
      continue;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changed.push(id);
    moves.push(...priceMoves(before, after, lastPrices));
  }
  return { changed, removed, moves };
}

export function withSource(moves: PriceMove[], source: MoveSource): Move[] {
  return moves.map((m) => ({ ...m, source }));
}
