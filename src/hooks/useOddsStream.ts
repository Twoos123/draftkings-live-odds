"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedStatus, Game, LatencyStats, StreamMessage } from "@/lib/odds/types";
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
/** Give up on the Refresh spinner if no new DraftKings check lands by then. */
const REFRESH_TIMEOUT_MS = 8_000;

/**
 * Measure server clock minus browser clock, NTP style: take the round trip
 * with the smallest RTT and assume the server answered halfway through it.
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

/** Live board over Server-Sent Events, with reconnects, a silence watchdog and latency measurement. */
export function useOddsStream() {
  const [games, setGames] = useState<Map<string, Game>>(() => new Map());
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  /** Browser time of the last message of any kind. */
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [latency, setLatency] = useState<ClientLatency>({ endToEnd: null, serverToBrowser: null });
  const [refreshing, setRefreshing] = useState(false);
  /** Server clock minus browser clock, in ms. */
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const connectRef = useRef<(resync?: boolean) => void>(() => {});
  const statusRef = useRef<FeedStatus | null>(null);
  /** lastSnapshotAt when Refresh was pressed; null when not refreshing. */
  const refreshBaseline = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let es: EventSource | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    let clockOffset = 0;
    /** Until the offset is measured, browser-side latency would be off by the clock difference. */
    let clockReady = false;
    const e2e = new RollingWindow(100);
    const hop = new RollingWindow(100);

    const onStatus = (s: FeedStatus) => {
      statusRef.current = s;
      setStatus(s);
      if (refreshBaseline.current !== undefined && s.lastSnapshotAt !== refreshBaseline.current) {
        refreshBaseline.current = undefined;
        setRefreshing(false);
      }
    };

    // Every message carries sentAt, so heartbeats time the server -> browser hop
    // even when no line is moving; real moves also give the full DK -> screen time.
    const received = (sentAt: string, dkCreatedAt?: string | null) => {
      lastMessage = Date.now();
      retries = 0;
      if (clockReady) {
        const serverNow = lastMessage + clockOffset;
        hop.push(serverNow - Date.parse(sentAt));
        if (dkCreatedAt) e2e.push(serverNow - Date.parse(dkCreatedAt));
        setLatency({ endToEnd: e2e.stats(), serverToBrowser: hop.stats() });
      }
      setLastMessageAt(lastMessage);
      setConnection("open");
    };

    function connect(resync = false) {
      clearTimeout(retryTimer);
      es?.close();
      const source = new EventSource(resync ? "/api/stream?resync=1" : "/api/stream");
      es = source;
      lastMessage = Date.now();

      source.addEventListener("snapshot", (e) => {
        const msg = JSON.parse((e as MessageEvent<string>).data) as Extract<StreamMessage, { type: "snapshot" }>;
        setGames(new Map(msg.games.map((g) => [g.id, g])));
        onStatus(msg.status);
        received(msg.sentAt);
      });

      source.addEventListener("update", (e) => {
        const msg = JSON.parse((e as MessageEvent<string>).data) as Extract<StreamMessage, { type: "update" }>;
        // Unchanged games keep their object identity, so their rows skip re-rendering.
        setGames((prev) => {
          const next = new Map(prev);
          for (const g of msg.games) next.set(g.id, g);
          for (const id of msg.removed) next.delete(id);
          return next;
        });
        received(msg.sentAt, msg.timing?.dkCreatedAt);
      });

      source.addEventListener("status", (e) => {
        const msg = JSON.parse((e as MessageEvent<string>).data) as Extract<StreamMessage, { type: "status" }>;
        onStatus(msg.status);
        received(msg.sentAt);
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

    connectRef.current = (resync) => {
      setConnection((c) => (c === "open" ? c : "reconnecting"));
      connect(resync);
    };
    connect();

    measureClockOffset()
      .then((offset) => {
        clockOffset = offset;
        clockReady = true;
        setClockOffsetMs(offset);
      })
      .catch(() => {});

    // A proxy or a sleeping laptop can leave a dead stream that never errors.
    const watchdog = setInterval(() => {
      if (es && Date.now() - lastMessage > SILENCE_LIMIT_MS) {
        setConnection("reconnecting");
        connect();
      }
    }, 2_000);

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
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(watchdog);
      clearTimeout(hiddenTimer);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      es?.close();
      es = null;
    };
  }, []);

  /** Refresh button: reconnect and have the server re-check every line with DraftKings first. */
  const refresh = useCallback(() => {
    refreshBaseline.current = statusRef.current?.lastSnapshotAt ?? null;
    setRefreshing(true);
    connectRef.current(true);
    setTimeout(() => {
      refreshBaseline.current = undefined;
      setRefreshing(false);
    }, REFRESH_TIMEOUT_MS);
  }, []);

  return { games, status, connection, lastMessageAt, latency, refresh, refreshing, clockOffsetMs };
}
