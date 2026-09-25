import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSnapshot, parseWsMessage, type DkDelta, type DkSelection } from "@/lib/dk/schema";
import { mergeSnapshots } from "@/lib/dk/snapshot";

const fixtures = join(__dirname, "fixtures");

/** Raw fixture JSON, as DraftKings sent it. */
export function readFixture(name: string): { events: unknown[]; markets: unknown[]; selections: unknown[] } {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

/** Real NFL game-lines snapshot captured from DraftKings (US-NJ): full game only. */
export function loadSnapshot() {
  return parseSnapshot(readFixture("nfl-snapshot.json"));
}

/**
 * Real NFL "1st Half" snapshot (subcategory 4631), captured the same week: 14
 * of those games, the Sunday ones. The rest had no 1st-half lines posted yet.
 */
export function loadHalfSnapshot() {
  return parseSnapshot(readFixture("nfl-1h-snapshot.json"));
}

/** The whole board as fetchSnapshot returns it: full game and 1st half merged. */
export function loadBoardSnapshot() {
  return mergeSnapshots(loadSnapshot(), loadHalfSnapshot());
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
