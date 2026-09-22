import type { ClientLatency } from "@/hooks/useOddsStream";
import { formatAgo } from "@/lib/odds/freshness";
import type { BoardStatus, FeedStatus, LatencyStats } from "@/lib/odds/types";

function ms(stats: LatencyStats | null | undefined): string {
  return stats ? `${stats.p50} ms median · ${stats.p95} ms p95 (${stats.n})` : "—";
}

/** The numbers behind the status pill, for anyone who wants to check our work. */
export function FeedDetails({
  feed,
  board,
  latency,
  now,
  serverNow,
}: {
  feed: FeedStatus | null;
  board: BoardStatus;
  latency: ClientLatency;
  /** Browser clock. */
  now: number;
  /** Browser clock corrected to DraftKings' (server timestamps are on DK's clock). */
  serverNow: number;
}) {
  const agoServer = (iso: string | null | undefined) => (iso ? formatAgo(serverNow - Date.parse(iso)) : "—");
  const rows: [string, string][] = [
    ["Board (loaded in your browser from DraftKings)", board.lastSnapshotAt !== null ? `last checked ${formatAgo(now - board.lastSnapshotAt)}` : board.snapshotError ?? "loading…"],
    ["  line moves · full checks · prices they corrected", `${board.counters.moves} · ${board.counters.resyncs} · ${board.counters.resyncCorrections}`],
  ];
  if (board.snapshotError && board.lastSnapshotAt !== null) rows.push(["  last check failed", board.snapshotError]);
  if (feed) {
    rows.push(
      ["DraftKings live feed (our server)", `${feed.ws}${feed.subscribed ? ", subscribed" : ""} · ${feed.health}`],
      ["  last update from DraftKings", agoServer(feed.lastMessageAt)],
      ["DraftKings → our server", ms(feed.dkToServerMs)],
      ["  of which inside DraftKings (before publishing)", ms(feed.dkInternalMs)],
      ["  of which on the wire", ms(feed.wireMs)],
      ["Our server → your browser", ms(latency.serverToBrowser)],
      ["DraftKings → your screen", ms(latency.endToEnd)],
      ["Updates relayed · reconnects · bad records", `${feed.counters.updates} · ${feed.counters.reconnects} · ${feed.counters.parseIssues}`],
      [
        "Server's own copy of the board",
        feed.serverBoard.snapshotError
          ? `unavailable: ${feed.serverBoard.snapshotError}. That's why the board loads in your browser.`
          : feed.serverBoard.lastSnapshotAt
            ? `checked ${agoServer(feed.serverBoard.lastSnapshotAt)} · ${feed.serverBoard.resyncCorrections} corrections`
            : "—",
      ],
      [
        "ClickHouse",
        feed.sink.enabled
          ? `${feed.sink.written} rows written${feed.sink.lastError ? ` · error: ${feed.sink.lastError}` : ""}`
          : "off on this deployment (optional local analytics, see README)",
      ],
      ["Server instance · clock offset to DraftKings", `${feed.instanceId} · ${feed.dkClockOffsetMs} ms`],
    );
    if (feed.lastError) rows.push(["Last feed error", feed.lastError]);
  }

  return (
    <details className="mt-8 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-medium">Feed details</summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="whitespace-pre text-muted">{k}</dt>
            <dd className="mb-1 tabular-nums sm:mb-0">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-muted">
        Raw data: <a className="underline" href="/api/health">/api/health</a> · <a className="underline" href="/api/odds">/api/odds</a> (server&apos;s copy, if
        DraftKings allows it)
      </p>
    </details>
  );
}
