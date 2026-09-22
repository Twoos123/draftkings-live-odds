import type { DkDelta, DkEvent, DkMarket, DkSelection, DkSnapshot } from "../dk/schema";

export interface ApplyResult {
  /** Events whose games may look different now. */
  touched: Set<string>;
  /** Changes we couldn't place (unknown ids). A REST resync fixes these. */
  unresolved: string[];
}

/** Copy `patch` onto `base`, ignoring fields the patch doesn't carry. */
function merge<T extends object>(base: T | undefined, patch: T): T {
  const out = { ...(base ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function addToIndex(index: Map<string, Set<string>>, key: string, id: string) {
  const set = index.get(key);
  if (set) set.add(id);
  else index.set(key, new Set([id]));
}

function removeFromIndex(index: Map<string, Set<string>>, key: string | undefined, id: string) {
  if (key === undefined) return;
  const set = index.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) index.delete(key);
}

const MAIN_MARKET_PREFIX: Record<string, string> = { ML: "1", HC: "2", OU: "3" };

/**
 * Main-line selection ids embed their market: "0HC84695613N600_1" is a
 * selection in market "2_84695613" (HC = handicap/spread = market type 2).
 * Only used as a fallback when an update omits marketId.
 */
export function inferMarketId(selectionId: string): string | null {
  const m = /^0(ML|HC|OU)(\d+)/.exec(selectionId);
  return m ? `${MAIN_MARKET_PREFIX[m[1]]}_${m[2]}` : null;
}

/**
 * DraftKings' entities exactly as DK models them (events, markets, selections
 * in flat id-keyed maps), kept current by applying push-feed deltas.
 *
 * The feed sends only what changed:
 *  - `change` objects are partial and get merged onto what we have;
 *  - when a spread/total moves, the selection gets a *new id* and the change
 *    carries `replacedSelectionId` (and usually no marketId), so we carry the
 *    old selection's fields over and drop the old id.
 *
 * Parent -> children indexes let one game be rebuilt without scanning the
 * whole board, so the cost of an update doesn't grow with the number of games.
 * The maps are read-only outside this class; all writes go through it.
 */
export class DkStore {
  readonly events = new Map<string, DkEvent>();
  readonly markets = new Map<string, DkMarket>();
  readonly selections = new Map<string, DkSelection>();
  private readonly marketIdsByEvent = new Map<string, Set<string>>();
  private readonly selectionIdsByMarket = new Map<string, Set<string>>();

  static fromSnapshot(snapshot: DkSnapshot): DkStore {
    const store = new DkStore();
    for (const e of snapshot.events) store.events.set(e.id, e);
    for (const m of snapshot.markets) store.setMarket(m);
    for (const s of snapshot.selections) store.setSelection(s);
    return store;
  }

  marketsOf(eventId: string): DkMarket[] {
    const ids = this.marketIdsByEvent.get(eventId);
    return ids ? [...ids].map((id) => this.markets.get(id)!) : [];
  }

  selectionsOf(marketId: string): DkSelection[] {
    const ids = this.selectionIdsByMarket.get(marketId);
    return ids ? [...ids].map((id) => this.selections.get(id)!) : [];
  }

  apply(delta: DkDelta): ApplyResult {
    const touched = new Set<string>();
    const unresolved: string[] = [];

    for (const e of delta.add.events) this.upsertEvent(e, touched, unresolved);
    for (const m of delta.add.markets) this.upsertMarket(m, touched, unresolved);
    for (const s of delta.add.selections) this.upsertSelection(s, touched, unresolved);

    for (const e of delta.change.events) this.upsertEvent(e, touched, unresolved);
    for (const m of delta.change.markets) this.upsertMarket(m, touched, unresolved);
    for (const s of delta.change.selections) this.upsertSelection(s, touched, unresolved);

    for (const id of delta.remove.selections) {
      const eventId = this.eventIdOfSelection(id);
      if (this.deleteSelection(id) && eventId) touched.add(eventId);
    }
    for (const id of delta.remove.markets) {
      const eventId = this.markets.get(id)?.eventId;
      if (this.deleteMarket(id) && eventId) touched.add(eventId);
    }
    for (const id of delta.remove.events) {
      if (!this.events.has(id)) continue;
      for (const m of this.marketsOf(id)) this.deleteMarket(m.id);
      this.events.delete(id);
      touched.add(id);
    }

    return { touched, unresolved };
  }

  private upsertEvent(e: DkEvent, touched: Set<string>, unresolved: string[]) {
    const prev = this.events.get(e.id);
    if (!prev && !e.participants) {
      // A partial change for a game we've never seen: nothing to merge onto.
      unresolved.push(`event:${e.id}`);
      return;
    }
    this.events.set(e.id, merge(prev, e));
    touched.add(e.id);
  }

  private upsertMarket(m: DkMarket, touched: Set<string>, unresolved: string[]) {
    const next = merge(this.markets.get(m.id), m);
    if (!next.eventId) {
      unresolved.push(`market:${m.id}`);
      return;
    }
    this.setMarket(next);
    touched.add(next.eventId);
  }

  private upsertSelection(s: DkSelection, touched: Set<string>, unresolved: string[]) {
    let base = this.selections.get(s.id);
    if (s.replacedSelectionId && s.replacedSelectionId !== s.id) {
      const old = this.selections.get(s.replacedSelectionId);
      if (old) {
        base = merge(old, base ?? ({ id: s.id } as DkSelection));
        this.deleteSelection(s.replacedSelectionId);
      }
    }
    const next = merge(base, s);
    delete next.replacedSelectionId;
    if (!next.marketId) {
      const inferred = inferMarketId(s.id);
      if (inferred && this.markets.has(inferred)) next.marketId = inferred;
    }
    const eventId = next.marketId ? this.markets.get(next.marketId)?.eventId : undefined;
    if (!eventId) {
      unresolved.push(`selection:${s.id}`);
      return;
    }
    this.setSelection(next);
    touched.add(eventId);
  }

  private setMarket(m: DkMarket) {
    const prev = this.markets.get(m.id);
    if (prev?.eventId !== m.eventId) removeFromIndex(this.marketIdsByEvent, prev?.eventId, m.id);
    this.markets.set(m.id, m);
    if (m.eventId) addToIndex(this.marketIdsByEvent, m.eventId, m.id);
  }

  private setSelection(s: DkSelection) {
    const prev = this.selections.get(s.id);
    if (prev?.marketId !== s.marketId) removeFromIndex(this.selectionIdsByMarket, prev?.marketId, s.id);
    this.selections.set(s.id, s);
    if (s.marketId) addToIndex(this.selectionIdsByMarket, s.marketId, s.id);
  }

  private deleteSelection(id: string): boolean {
    const prev = this.selections.get(id);
    if (!prev) return false;
    removeFromIndex(this.selectionIdsByMarket, prev.marketId, id);
    this.selections.delete(id);
    return true;
  }

  private deleteMarket(id: string): boolean {
    const prev = this.markets.get(id);
    if (!prev) return false;
    for (const selId of [...(this.selectionIdsByMarket.get(id) ?? [])]) this.deleteSelection(selId);
    removeFromIndex(this.marketIdsByEvent, prev.eventId, id);
    this.markets.delete(id);
    return true;
  }

  private eventIdOfSelection(id: string): string | undefined {
    const marketId = this.selections.get(id)?.marketId;
    return marketId ? this.markets.get(marketId)?.eventId : undefined;
  }
}
