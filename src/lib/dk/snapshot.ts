import { FIRST_HALF_SUBCATEGORY_ID, GAME_LINES_SUBCATEGORY_ID, snapshotUrl } from "./config";
import { parseSnapshot, type DkSnapshot, type ParseIssue } from "./schema";

export class SnapshotError extends Error {}

/**
 * One subcategory of the NFL board from DraftKings' REST endpoint. Plain
 * fetch, no cookies or special headers: DK fronts this with Akamai, which
 * rejects some HTTP clients (curl, Python urllib) but serves Node's fetch
 * normally. A subcategory with nothing posted comes back as empty lists.
 */
export async function fetchSubcategory(subcategory: string, onIssue?: ParseIssue, timeoutMs = 8000): Promise<DkSnapshot> {
  let res: Response;
  try {
    res = await fetch(snapshotUrl(subcategory), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(err);
    throw new SnapshotError(`DraftKings unreachable: ${reason}`);
  }
  if (!res.ok) {
    throw new SnapshotError(`DraftKings snapshot returned HTTP ${res.status}${res.status === 403 ? " (blocked by Akamai)" : ""}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SnapshotError("DraftKings snapshot was not valid JSON");
  }
  return parseSnapshot(json, onIssue);
}

/** Several subcategories as one board. An entity in more than one keeps its first copy (games appear in both). */
export function mergeSnapshots(...parts: DkSnapshot[]): DkSnapshot {
  const merge = <T extends { id: string }>(lists: T[][]): T[] => {
    const byId = new Map<string, T>();
    for (const list of lists) for (const x of list) if (!byId.has(x.id)) byId.set(x.id, x);
    return [...byId.values()];
  };
  return {
    events: merge(parts.map((p) => p.events)),
    markets: merge(parts.map((p) => p.markets)),
    selections: merge(parts.map((p) => p.selections)),
  };
}

/**
 * The whole board: game lines and 1st-half lines, fetched in parallel (DK's
 * REST endpoint takes one subcategory per request). Both are required, so the
 * board never mixes a fresh full game with a missing 1st half; a failure keeps
 * the last good board, like any failed re-check. Game-lines errors are
 * reported first so the message doesn't depend on which request lost the race.
 */
export async function fetchSnapshot(onIssue?: ParseIssue, timeoutMs = 8000): Promise<DkSnapshot> {
  const [full, half] = await Promise.allSettled([
    fetchSubcategory(GAME_LINES_SUBCATEGORY_ID, onIssue, timeoutMs),
    fetchSubcategory(FIRST_HALF_SUBCATEGORY_ID, onIssue, timeoutMs),
  ]);
  if (full.status === "rejected") throw full.reason;
  if (half.status === "rejected") {
    const reason = half.reason instanceof Error ? half.reason.message : String(half.reason);
    throw new SnapshotError(`1st-half lines: ${reason}`);
  }
  return mergeSnapshots(full.value, half.value);
}
