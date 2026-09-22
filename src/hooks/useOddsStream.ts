"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSnapshot } from "@/lib/dk/snapshot";
import { BoardEngine } from "@/lib/odds/engine";
import type { BoardStatus, FeedStatus, Game, LatencyStats, StreamMessage } from "@/lib/odds/types";
import { RollingWindow } from "@/lib/stats";

export type Connection = "connecting" | "open" | "reconnecting";

export interface ClientLatency {
  /** DraftKings created the change -> it was on this screen. */
  endToEnd: LatencyStats | null;
  /** Our server sent it -> this browser got it. */
  serverToBrowser: LatencyStats | null;
}

/** Status heartbeats arrive every 5s; this much silence means the connection is dead. */
const SILENCE_LIMIT_MS = 15_000;
/** Close the stream if the tab stays hidden this long (saves server time); reopen on return. */
const HIDDEN_CLOSE_MS = 60_000;
/** Full re-check of the board with DraftKings while the push feed is up… */
const RECHECK_LIVE_MS = 60_000;
/** …and while it's down, so the board keeps moving without it. */
const RECHECK_FALLBACK_MS = 10_000;

const EMPTY_BOARD: BoardStatus = {
  hasData: false,
  lastSnapshotAt: null,
  snapshotError: null,
  counters: { moves: 0, resyncs: 0, resyncCorrections: 0, unresolved: 0 },
};

/**
 * Measure DraftKings-clock minus browser clock via /api/time, NTP style: take
 * the round trip with the smallest RTT and assume the server answered halfway.
 */
async function measureClockOffset(): Promise<number> {
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const res = await fetch("/api/time", { cache: "no-store" });
    const { now } = (await res.json()) as { now: number };
    const t1 = Date.now();
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: now - (t0 + t1) / 2 };
  }
  return best.offset;
}

/**
 * The live board, built in the browser:
 *  - the full board is loaded straight from DraftKings' REST endpoint (DK
 *    allows browsers to read it cross-origin; it blocks cloud servers);
 *  - our server relays DraftKings' push updates over SSE, and the same
 *    BoardEngine the server uses applies them here;
 *  - the board is re-checked with DraftKings every 60s (10s while the push
 *    feed is down), and reloaded after any gap in the stream.
 */
export function useOddsStream() {
  const [games, setGames] = useState<Map<string, Game>>(() => new Map());
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  const [board, setBoard] = useState<BoardStatus>(EMPTY_BOARD);
  const [connection, setConnection] = useState<Connection>("connecting");
  /** Browser time of the last message of any kind from our server. */
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [latency, setLatency] = useState<ClientLatency>({ endToEnd: null, serverToBrowser: null });
  const [refreshing, setRefreshing] = useState(false);
  /** DraftKings clock minus browser clock, in ms. */
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let es: EventSource | null = null;
    let opened = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    let feedStatus: FeedStatus | null = null;
    let clockOffset = 0;
    /** Until the offset is measured, browser-side latency would be off by the clock difference. */
    let clockReady = false;
    const e2e = new RollingWindow(100);
    const hop = new RollingWindow(100);

    const engine = new BoardEngine({
      fetchSnapshot: (onIssue) => fetchSnapshot(onIssue),
      now: Date.now,
      onChange: (change) => {
        publishBoard();
        if (change.type === "snapshot") {
          setGames(new Map(change.games.map((g) => [g.id, g])));
          return;
        }
        // Unchanged games keep their object identity, so their rows skip re-rendering.
        setGames((prev) => {
          const next = new Map(prev);
          for (const g of change.games) next.set(g.id, g);
          for (const id of change.removed) next.delete(id);
          return next;
        });
      },
    });

    const publishBoard = () =>
      setBoard({ hasData: engine.hasData, lastSnapshotAt: engine.lastSnapshotAt, snapshotError: engine.snapshotError, counters: { ...engine.counters } });

    const loadBoard = async () => {
      await engine.resync();
      publishBoard();
    };

    const received = (sentAt: string, dkCreatedAt?: string | null) => {
      lastMessage = Date.now();
      retries = 0;
      if (clockReady) {
        const dkNow = lastMessage + clockOffset;
        hop.push(dkNow - Date.parse(sentAt));
        if (dkCreatedAt) e2e.push(dkNow - Date.parse(dkCreatedAt));
        setLatency({ endToEnd: e2e.stats(), serverToBrowser: hop.stats() });
      }
      setLastMessageAt(lastMessage);
      setConnection("open");
    };

    const applyDelta = (data: string) => {
      const msg = JSON.parse(data) as Extract<StreamMessage, { type: "delta" }>;
      engine.apply(msg.delta, { createdTime: msg.timing.dkCreatedAt, publishedTime: msg.timing.dkPublishedAt, wsPublishedTime: null }, Date.now());
      return msg;
    };

    function connect() {
      clearTimeout(retryTimer);
      es?.close();
      const source = new EventSource("/api/stream");
      es = source;
      lastMessage = Date.now();

      source.onopen = () => {
        // Any gap in the stream may have dropped updates: reload the board after a reconnect.
        if (opened) void loadBoard();
        opened = true;
      };

      source.addEventListener("status", (e) => {
        const msg = JSON.parse((e as MessageEvent<string>).data) as Extract<StreamMessage, { type: "status" }>;
        feedStatus = msg.status;
        setFeed(msg.status);
        received(msg.sentAt);
      });

      source.addEventListener("delta", (e) => {
        const msg = applyDelta((e as MessageEvent<string>).data);
        received(msg.sentAt, msg.timing.dkCreatedAt);
        publishBoard();
      });

      // Catch-up deltas from the last ~10s: applied, but not timed.
      source.addEventListener("replay", (e) => {
        applyDelta((e as MessageEvent<string>).data);
      });

      source.onerror = () => {
        if (es !== source) return;
        setConnection("reconnecting");
        // EventSource retries network drops by itself; if it gave up (e.g. an HTTP error), retry with backoff.
        if (source.readyState === EventSource.CLOSED) {
          const delay = Math.min(30_000, 1000 * 2 ** retries++);
          retryTimer = setTimeout(() => connect(), delay);
        }
      };
    }

    connect();
    void loadBoard();

    measureClockOffset()
      .then((offset) => {
        clockOffset = offset;
        clockReady = true;
        setClockOffsetMs(offset);
      })
      .catch(() => {});

    const timer = setInterval(() => {
      // A proxy or a sleeping laptop can leave a dead stream that never errors.
      if (es && Date.now() - lastMessage > SILENCE_LIMIT_MS) {
        setConnection("reconnecting");
        connect();
      }
      // Periodic full check with DraftKings (skipped while the tab is closed down).
      if (!es) return;
      const base = feedStatus?.health === "live" ? RECHECK_LIVE_MS : RECHECK_FALLBACK_MS;
      const wait = Math.min(base * 2 ** Math.min(engine.snapshotFailures, 3), 60_000);
      if (Date.now() - engine.lastSnapshotAttemptAt >= wait) void loadBoard();
    }, 1_000);

    const onVisibility = () => {
      if (document.hidden) {
        hiddenTimer = setTimeout(() => {
          es?.close();
          es = null;
        }, HIDDEN_CLOSE_MS);
      } else {
        clearTimeout(hiddenTimer);
        if (!es) {
          setConnection("reconnecting");
          connect();
          void loadBoard();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    refreshRef.current = async () => {
      if (!es) connect();
      await loadBoard();
    };

    return () => {
      clearInterval(timer);
      clearTimeout(hiddenTimer);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      es?.close();
      es = null;
    };
  }, []);

  /** Refresh button: re-check every line with DraftKings right now. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { games, feed, board, connection, lastMessageAt, latency, refresh, refreshing, clockOffsetMs };
}
