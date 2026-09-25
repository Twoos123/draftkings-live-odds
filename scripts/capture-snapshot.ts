/**
 * Save one subcategory of DraftKings' NFL board, raw, as a test fixture:
 *
 *   npx tsx scripts/capture-snapshot.ts 4631 test/fixtures/nfl-1h-snapshot.json
 *
 * Raw (not parsed) so tests exercise the same parsing as the live board.
 */
import { writeFileSync } from "node:fs";
import { snapshotUrl } from "../src/lib/dk/config";

const [subcategory, out] = process.argv.slice(2);
if (!subcategory || !out) {
  console.error("usage: tsx scripts/capture-snapshot.ts <subcategoryId> <out.json>");
  process.exit(2);
}

async function main(subcategory: string, out: string) {
  const res = await fetch(snapshotUrl(subcategory), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`DraftKings returned HTTP ${res.status}`);
  const json = (await res.json()) as { events: unknown[]; markets: unknown[]; selections: unknown[] };
  writeFileSync(out, JSON.stringify(json));
  console.log(`${out}: ${json.events.length} events, ${json.markets.length} markets, ${json.selections.length} selections`);
}

void main(subcategory, out);
