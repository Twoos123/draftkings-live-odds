import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSnapshot, parseWsMessage, type DkDelta, type DkSelection } from "@/lib/dk/schema";

const fixtures = join(__dirname, "fixtures");

/** Real NFL game-lines snapshot captured from DraftKings (US-NJ). */
export function loadSnapshot() {
  return parseSnapshot(JSON.parse(readFileSync(join(fixtures, "nfl-snapshot.json"), "utf8")));
}

/** Real push-feed frames recorded from DraftKings. */
export function loadWsFrames(): string[] {
  return readFileSync(join(fixtures, "ws-messages.jsonl"), "utf8").split("\n").filter(Boolean);
}

export function emptyDelta(): DkDelta {
  return {
    add: { events: [], markets: [], selections: [] },
    change: { events: [], markets: [], selections: [] },
    remove: { events: [], markets: [], selections: [] },
  };
}

export function deltaOf(part: (d: DkDelta) => void): DkDelta {
  const d = emptyDelta();
  part(d);
  return d;
}

export function updateFrame(body: object, meta: Record<string, string> = {}): string {
  return JSON.stringify({ event: "update", data: { data: body, metadata: meta } });
}

export function parseUpdate(raw: string) {
  const m = parseWsMessage(raw);
  if (m.kind !== "update") throw new Error(`expected update, got ${m.kind}`);
  return m;
}

export function odds(american: number, decimal: number): DkSelection["displayOdds"] {
  return { american: american < 0 ? `−${-american}` : `+${american}`, decimal: decimal.toFixed(2) };
}
