import type { DkDelta } from "@/lib/dk/schema";
import { formatAmerican, americanToDecimal } from "@/lib/odds/format";
import { getHub } from "@/lib/server";

/**
 * Development only: nudge a random moneyline as if DraftKings had moved it,
 * through the same code path as a real push-feed update. Lets you see the
 * move highlight without waiting for a real line move. 404 in production.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const hub = getHub();
  const candidates = hub.games().filter((g) => g.markets.moneyline && !g.markets.moneyline.suspended);
  const game = candidates[Math.floor(Math.random() * candidates.length)];
  if (!game) return Response.json({ error: "no board yet; open the page first" }, { status: 409 });

  const sel = game.markets.moneyline!.selections[Math.floor(Math.random() * 2)];
  let american = sel.american + (Math.random() < 0.5 ? -10 : 10);
  if (Math.abs(american) < 100) american = american > 0 ? -110 : 110;
  const decimal = Math.round(americanToDecimal(american) * 100) / 100;
  const delta: DkDelta = {
    add: { events: [], markets: [], selections: [] },
    change: { events: [], markets: [], selections: [{ id: sel.id, displayOdds: { american: formatAmerican(american), decimal: decimal.toFixed(2) }, trueOdds: decimal }] },
    remove: { events: [], markets: [], selections: [] },
  };
  const now = Date.now();
  hub.ingest(delta, { createdTime: new Date(now).toISOString(), publishedTime: null, wsPublishedTime: null }, now);
  return Response.json({ game: game.name, side: sel.side, from: sel.american, to: american });
}
