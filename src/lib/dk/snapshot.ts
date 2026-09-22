import { snapshotUrl } from "./config";
import { parseSnapshot, type DkSnapshot, type ParseIssue } from "./schema";

export class SnapshotError extends Error {}

/**
 * Full NFL game-lines board from DraftKings' REST endpoint. Plain fetch, no
 * cookies or special headers: DK fronts this with Akamai, which rejects some
 * HTTP clients (curl, Python urllib) but serves Node's fetch normally.
 */
export async function fetchSnapshot(onIssue?: ParseIssue, timeoutMs = 8000): Promise<DkSnapshot> {
  let res: Response;
  try {
    res = await fetch(snapshotUrl(), {
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
