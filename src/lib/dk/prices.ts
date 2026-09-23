import { oddsOf } from "../odds/normalize";
import { inferMarketId } from "../odds/store";
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

/** Every side on the board, in the form browsers send it to the server. */
export function boardSides(games: Iterable<Game>): BoardSide[] {
  const sides: BoardSide[] = [];
  for (const g of games) {
    for (const m of Object.values(g.markets)) {
      for (const s of m!.selections) {
        sides.push({ marketId: m!.id, selectionId: s.id, label: s.label, line: s.line, american: s.american, decimal: s.decimal });
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
  private known = new Map<string, Known>();
  /** Selection id -> label, for changes that leave the label out (DK's changes are partial). */
  private labels = new Map<string, string>();
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
    this.known.clear();
    this.labels.clear();
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
    this.labels = new Map(sides.map((s) => [s.selectionId, s.label]));
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
      const marketId = s.marketId ?? inferMarketId(s.id);
      const label = s.label ?? this.labels.get(s.id) ?? (s.replacedSelectionId && this.labels.get(s.replacedSelectionId));
      if (!marketId || !this.markets.has(marketId) || !label) continue;
      this.labels.set(s.id, label);
      const key = sideOf(marketId, label);
      const known = this.known.get(key);
      const odds = oddsOf(s);
      // The line is part of the selection id, so a partial change to the same id keeps it.
      const line = s.points ?? (known?.selectionId === s.id ? known.price.line : null);
      if (!odds || (line === null && /^0(HC|OU)/.test(s.id))) continue;
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
