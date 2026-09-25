import type { DkDelta } from "../dk/schema";

// The clean shape we serve, independent of DraftKings' wire format:
// game -> period -> market -> side -> line + odds. Shared by the server and the browser.

export type MarketType = "moneyline" | "spread" | "total";
export type Side = "away" | "home" | "over" | "under";
/** The whole game, or its 1st half (DraftKings' separate "1st Half" markets). */
export type Period = "full" | "half";
export const PERIODS = ["full", "half"] as const satisfies readonly Period[];

/** A period's markets by type. Empty when DraftKings has none posted (1st-half lines go up a few days out and come down mid-game). */
export type PeriodMarkets = Partial<Record<MarketType, Market>>;

export interface Price {
  /** Spread or total points; null for moneyline. */
  line: number | null;
  american: number;
  decimal: number;
}

export interface Selection extends Price {
  id: string;
  side: Side;
  label: string;
  /** Previous price, if it moved while we were watching. */
  prev?: Price;
  /** When DraftKings made the last move (ISO). */
  changedAt?: string;
}

export interface Market {
  id: string;
  type: MarketType;
  period: Period;
  suspended: boolean;
  /**
   * [away, home] for moneyline/spread, [over, under] for totals: the sides
   * with a price right now. Can be short or empty for a moment while
   * DraftKings swaps a line (it removes the old one before adding the new).
   */
  selections: Selection[];
}

export interface Team {
  id: string;
  name: string;
  short: string;
  /** Primary team colour from DraftKings, e.g. "#203731". */
  color?: string;
}

export interface Game {
  id: string;
  name: string;
  startTime: string;
  /** DraftKings event status, e.g. NOT_STARTED, STARTED. */
  status: string;
  away: Team;
  home: Team;
  markets: Record<Period, PeriodMarkets>;
}

export interface PriceMove {
  gameId: string;
  period: Period;
  market: MarketType;
  side: Side;
  selectionId: string;
  from: Price;
  to: Price;
}

/** Where a change came from: the push feed, or a periodic REST re-check that found drift. */
export type MoveSource = "ws" | "resync";

export interface Move extends PriceMove {
  source: MoveSource;
}

/** Timing for one DraftKings update as it passed through the server. */
export interface UpdateTiming {
  dkCreatedAt: string | null;
  dkPublishedAt: string | null;
  serverReceivedAt: string;
}

/**
 * The server's connection to DraftKings' push feed. "idle": no viewers on this
 * server instance, so it isn't connected (it connects on the first viewer).
 */
export type FeedHealth = "idle" | "starting" | "live" | "reconnecting" | "down";

export interface LatencyStats {
  p50: number;
  p95: number;
  n: number;
}

export interface FeedStatus {
  health: FeedHealth;
  /** On DraftKings' clock, like every timestamp we emit. */
  serverTime: string;
  /** DraftKings' clock minus this server's, estimated from the subscribe round trip. */
  dkClockOffsetMs: number;
  instanceId: string;
  ws: "idle" | "connecting" | "open" | "closed";
  subscribed: boolean;
  /** When the current push-feed subscription was acknowledged. */
  subscribedAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
  /** DK created the change -> our server received it. */
  dkToServerMs: LatencyStats | null;
  /** DK's websocket server sent it -> our server received it. */
  wireMs: LatencyStats | null;
  /** DK created the change -> DK published it: time spent inside DraftKings, out of our hands. */
  dkInternalMs: LatencyStats | null;
  counters: { updates: number; parseIssues: number; reconnects: number };
  /**
   * The server's own copy of the board, used for /api/odds and ClickHouse.
   * Only works where DraftKings' REST endpoint accepts the server's IP; on
   * Vercel it's blocked by Akamai and the board lives in the browser instead.
   */
  serverBoard: {
    lastSnapshotAt: string | null;
    snapshotError: string | null;
    moves: number;
    resyncCorrections: number;
  };
  sink: { enabled: boolean; lastError: string | null; written: number };
  /**
   * Price-change recording for line history; null when there's no database.
   * `needsBoard`: the server has no recent copy of the board's prices to
   * measure moves against, so browsers should send theirs (see BoardSide).
   */
  history: { needsBoard: boolean; markets: number } | null;
}

/** One side of the board as a browser sends it to the server, so moves have a "from" price. */
export interface BoardSide extends Price {
  marketId: string;
  selectionId: string;
  label: string;
}

/** Where a recorded move's previous price came from. */
export type FromSource = "feed" | "board" | "viewer";

/** One price change DraftKings pushed, as recorded for line history (/api/history). */
export interface RecordedChange {
  marketId: string;
  selectionId: string;
  /** DraftKings' label for the side: a team name, "Over" or "Under". */
  label: string;
  to: Price;
  /** The price before, if known; null when recording started mid-way. */
  from: Price | null;
  /**
   * `feed`: seen earlier on the same push-feed connection. `board`: the
   * server's own board. `viewer`: the board a viewer's browser loaded from
   * DraftKings. The new price and its time always come from the push feed.
   */
  fromSource: FromSource | null;
  /** When DraftKings made the change (ISO). */
  at: string;
}

/** The browser's copy of the board (see BoardEngine). */
export interface BoardStatus {
  hasData: boolean;
  /** Browser time of the last successful load from DraftKings. */
  lastSnapshotAt: number | null;
  snapshotError: string | null;
  counters: { moves: number; resyncs: number; resyncCorrections: number; unresolved: number };
}

/** Server-Sent Events from /api/stream. */
export type StreamMessage =
  | { type: "status"; status: FeedStatus; sentAt: string }
  /** One DraftKings push update, passed through as-is for the browser's board. */
  | { type: "delta"; delta: DkDelta; timing: UpdateTiming; sentAt: string };
