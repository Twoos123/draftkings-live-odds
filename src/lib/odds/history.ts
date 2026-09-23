import type { Game, Market, MarketType, Price, PriceMove, RecordedChange, Side } from "./types";

/** A line move on the board, either recorded (line history) or seen live on this page. */
export interface LineMove {
  key: string;
  gameId: string;
  market: MarketType;
  side: Side;
  /** Null when the price before wasn't recorded. */
  from: Price | null;
  to: Price;
  /** When DraftKings made the change, ms on its clock. */
  at: number;
}

/** +1 if the price went up (or, at the same price, the line did), −1 if down. */
export function direction(from: Price, to: Price): number {
  if (from.american !== to.american) return Math.sign(to.american - from.american);
  return Math.sign((to.line ?? 0) - (from.line ?? 0));
}

function moveKey(gameId: string, market: MarketType, side: Side, at: number): string {
  return `${gameId}:${market}:${side}:${at}`;
}

/** Recorded changes carry DK's label for the side; the board says which side has it. */
function sideOf(game: Game, market: Market, label: string): Side | null {
  const sel = market.selections.find((s) => s.label === label);
  if (sel) return sel.side;
  if (market.type === "total") return label === "Over" ? "over" : label === "Under" ? "under" : null;
  return label === game.away.name ? "away" : label === game.home.name ? "home" : null;
}

/** Recorded changes placed on the board. Changes for markets no longer on it are dropped. */
export function placeChanges(games: Iterable<Game>, changes: RecordedChange[]): LineMove[] {
  const markets = new Map<string, { game: Game; market: Market }>();
  for (const g of games) for (const m of Object.values(g.markets)) markets.set(m!.id, { game: g, market: m! });
  const moves: LineMove[] = [];
  for (const c of changes) {
    const hit = markets.get(c.marketId);
    const side = hit && sideOf(hit.game, hit.market, c.label);
    if (!hit || !side) continue;
    const at = Date.parse(c.at);
    moves.push({ key: moveKey(hit.game.id, hit.market.type, side, at), gameId: hit.game.id, market: hit.market.type, side, from: c.from, to: c.to, at });
  }
  return moves;
}

/** Moves the board engine found in one update, stamped with when DraftKings made them. */
export function lineMoves(moves: PriceMove[], at: number): LineMove[] {
  return moves.map((m) => ({ key: moveKey(m.gameId, m.market, m.side, at), gameId: m.gameId, market: m.market, side: m.side, from: m.from, to: m.to, at }));
}

/**
 * Newest first, each move once: a move seen live is usually recorded too.
 * Earlier lists win, so pass live moves first (they always know the price before).
 */
export function mergeMoves(...lists: LineMove[][]): LineMove[] {
  const byKey = new Map<string, LineMove>();
  for (const list of lists) for (const m of list) if (!byKey.has(m.key)) byKey.set(m.key, m);
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}
