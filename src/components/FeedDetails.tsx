import type { ClientLatency } from "@/hooks/useOddsStream";
import { formatAgo } from "@/lib/odds/freshness";
import type { FeedStatus, LatencyStats } from "@/lib/odds/types";

function ms(stats: LatencyStats | null): string {
  return stats ? `${stats.p50} ms median · ${stats.p95} ms p95 (${stats.n})` : "—";
}

/** The numbers behind the status pill, for anyone who wants to check our work. */
export function FeedDetails({ status, latency, serverNow }: { status: FeedStatus | null; latency: ClientLatency; serverNow: number }) {
  const ago = (iso: string | null | undefined) => (iso ? formatAgo(serverNow - Date.parse(iso)) : "—");
  const rows: [string, string][] = status
    ? [
        ["DraftKings live feed", `${status.ws}${status.subscribed ? ", subscribed" : ""}`],
        ["Last update from DraftKings", ago(status.lastMessageAt)],
        ["Last full check with DraftKings", ago(status.lastSnapshotAt)],
        ["DraftKings → our server", ms(status.dkToServerMs)],
        ["  of which on the wire", ms(status.wireMs)],
        ["Our server → your browser", ms(latency.serverToBrowser)],
        ["DraftKings → your screen", ms(latency.endToEnd)],
        ["Updates · line moves", `${status.counters.updates} · ${status.counters.moves}`],
        ["Full checks · prices they corrected", `${status.counters.resyncs} · ${status.counters.resyncCorrections}`],
        ["Reconnects · unplaceable updates · bad records", `${status.counters.reconnects} · ${status.counters.unresolved} · ${status.counters.parseIssues}`],
        ["ClickHouse", status.sink.enabled ? `${status.sink.written} rows written${status.sink.lastError ? ` · error: ${status.sink.lastError}` : ""}` : "not configured"],
        ["Server instance", status.instanceId],
      ]
    : [];
  if (status?.lastError) rows.push(["Last error", status.lastError]);

  return (
    <details className="mt-8 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-medium">Feed details</summary>
      {rows.length === 0 ? (
        <p className="mt-3 text-muted">Waiting for the first status report…</p>
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="whitespace-pre text-muted">{k}</dt>
              <dd className="mb-1 tabular-nums sm:mb-0">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-muted">
        Raw data: <a className="underline" href="/api/odds">/api/odds</a> · <a className="underline" href="/api/health">/api/health</a>
      </p>
    </details>
  );
}
