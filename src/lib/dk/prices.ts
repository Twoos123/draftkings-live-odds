import { allMarkets, oddsOf } from "../odds/normalize";
import type { BoardSide, FromSource, Game, Price } from "../odds/types";
import type { DkDelta } from "./schema";

/** A price change from the push feed, with the price before it when we know it. */
export interface ObservedChange {
  marketId: string;
  selectionId: string;
  label: string;
  to: Price;
  from: Price | null;
  fromSource: FromSource | null;
}

/** Take a fresh copy of the board this often: new games get recorded, and "from" prices don't go stale. */
const BOARD_MAX_AGE_MS = 10 * 60_000;

interface Known {
  selectionId: string;
  price: Price;
  source: FromSource;
}

/** Which market and side a selection id belongs to. */
interface Placed {
  marketId: string;
  label: string;
}

/** Every side on the board, in the form browsers send it to the server. */
export function boardSides(games: Iterable<Game>): BoardSide[] {
  const sides: BoardSide[] = [];
  for (const g of games) {
    for (const m of allMarkets(g)) {
      for (const s of m.selections) {
        sides.push({ marketId: m.id, selectionId: s.id, label: s.label, line: s.line, american: s.american, decimal: s.decimal });
      }
    }
  }
  return sides;
}

/**
 * A side is its market plus DK's label for it ("GB Packers", "Over"). The
 * label survives a line move, when the selection gets a new id.
 */
function sideOf(marketId: string, label: string): string {
  return `${marketId}|${label}`;
}

/**
 * Turns push-feed updates into price changes for line history. Needs no
 * board of its own, so it works on Vercel.
 *
 * DraftKings' feed only says what a price changed *to*. The price before is
 * the last one seen for that side on this connection, or failing that, the
 * side's price on a recent copy of the board: the server's own where
 * DraftKings allows it, otherwise the one a viewer's browser loaded from
 * DraftKings. Only that board's markets are recorded; the feed also carries
 * some other sports' markets.
 */
export class PriceTracker {
  private markets = new Set<string>();
  /** Markets whose sides have a line (spread, total), so an update without one is incomplete. */
  private lineMarkets = new Set<string>();
  private known = new Map<string, Known>();
  /**
   * Selection id -> its market and label. DK's changes usually leave both
   * out, so this is learned from the board and then from the feed: an add
   * carries its marketId, and a line move's new id names the one it replaced.
   * Nothing is read from the ids themselves.
   */
  private placed = new Map<string, Placed>();
  private boardAt: number | null = null;

  get marketCount(): number {
    return this.markets.size;
  }

  /** True until a copy of the board arrives, and again once it's old. */
  needsBoard(now: number): boolean {
    return this.boardAt === null || now - this.boardAt > BOARD_MAX_AGE_MS;
  }

  /** A new connection to DraftKings: nothing we knew still holds. */
  reset() {
    this.markets.clear();
    this.lineMarkets.clear();
    this.known.clear();
    this.placed.clear();
    this.boardAt = null;
  }

  /** Reconnected to DraftKings: updates may have been missed, so the prices we knew may be out of date. */
  forgetPrices() {
    this.known.clear();
    this.boardAt = null;
  }

  /**
   * A copy of the board. Its prices become the "from" for sides the feed
   * hasn't updated on this connection (the feed's are at least as new).
   * Returns how many sides were taken.
   */
  takeBoard(sides: BoardSide[], source: "board" | "viewer", now: number): number {
    this.markets = new Set(sides.map((s) => s.marketId));
    this.lineMarkets = new Set(sides.filter((s) => s.line !== null).map((s) => s.marketId));
    // Added to, not replaced: the feed may know a newer id than this copy of the board.
    for (const [id, p] of this.placed) if (!this.markets.has(p.marketId)) this.placed.delete(id);
    for (const s of sides) this.placed.set(s.selectionId, { marketId: s.marketId, label: s.label });
    for (const [key, k] of this.known) {
      if (!this.markets.has(key.slice(0, key.indexOf("|"))) && k.source !== "feed") this.known.delete(key);
    }
    let taken = 0;
    for (const s of sides) {
      const key = sideOf(s.marketId, s.label);
      if (this.known.get(key)?.source === "feed") continue;
      this.known.set(key, { selectionId: s.selectionId, price: { line: s.line, american: s.american, decimal: s.decimal }, source });
      taken++;
    }
    this.boardAt = now;
    return taken;
  }

  /** The price changes in one push-feed update. Updates that leave a price as it was are skipped. */
  observe(delta: DkDelta): ObservedChange[] {
    if (this.markets.size === 0) return [];
    const out: ObservedChange[] = [];
    const removed = new Set(delta.remove.selections);
    for (const s of [...delta.add.selections, ...delta.change.selections]) {
      const was = this.placed.get(s.id) ?? (s.replacedSelectionId ? this.placed.get(s.replacedSelectionId) : undefined);
      const marketId = s.marketId ?? was?.marketId;
      const label = s.label ?? was?.label;
      if (!marketId || !this.markets.has(marketId) || !label) continue;
      this.placed.set(s.id, { marketId, label });
      const key = sideOf(marketId, label);
      const known = this.known.get(key);
      const odds = oddsOf(s);
      // A line move gets a new selection id, so a partial change to the same id keeps its line.
      const line = s.points ?? (known?.selectionId === s.id ? known.price.line : null);
      if (!odds || (line === null && this.lineMarkets.has(marketId))) continue;
      const to: Price = { line, ...odds };
      // A known price only counts if it's for this selection or the one this replaced; otherwise we lost track.
      const linked = known && (known.selectionId === s.id || known.selectionId === s.replacedSelectionId || removed.has(known.selectionId));
      this.known.set(key, { selectionId: s.id, price: to, source: "feed" });
      const from = linked ? known.price : null;
      if (from && from.american === to.american && from.line === to.line) continue;
      out.push({ marketId, selectionId: s.id, label, to, from, fromSource: linked ? known.source : null });
    }
    return out;
  }
}
