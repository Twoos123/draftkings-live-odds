"use client";

import { useEffect, useState } from "react";
import type { RecordedChange } from "@/lib/odds/types";

export type Recorded =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; changes: RecordedChange[] }
  | { status: "error"; message: string };

/**
 * Recorded price changes for these DraftKings markets, from /api/history.
 * `query` adds parameters, e.g. "moves&limit=30". Fetched again whenever the
 * markets change; pass null to fetch nothing.
 */
export function useRecordedChanges(marketIds: string[] | null, query = ""): Recorded {
  const url = marketIds && marketIds.length ? `/api/history?markets=${marketIds.join(",")}${query ? `&${query}` : ""}` : null;
  const [result, setResult] = useState<{ url: string; value: Recorded } | null>(null);

  useEffect(() => {
    if (!url) return;
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        const body = (await res.json()) as { enabled: boolean; changes: RecordedChange[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setResult({ url, value: body.enabled ? { status: "ready", changes: body.changes } : { status: "off" } });
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setResult({ url, value: { status: "error", message: err instanceof Error ? err.message : String(err) } });
      });
    return () => ctl.abort();
  }, [url]);

  if (!url) return { status: "off" };
  return result?.url === url ? result.value : { status: "loading" };
}
