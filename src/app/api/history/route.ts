import { getHistory } from "@/lib/server";

/** A DraftKings market id (today "2_84695613"). Nothing assumes its format beyond fitting in a comma-separated list. */
const MARKET_ID = /^[^\s,]{1,100}$/;
const MAX_MARKETS = 300;
const MAX_ROWS = 2000;

/**
 * Recorded price changes for the given DraftKings markets, oldest first. The
 * browser knows which markets belong to which game from the board it loaded.
 * `?moves` leaves out changes whose previous price wasn't recorded; `limit`
 * caps the rows, keeping the newest. Recorded only while someone has the site
 * open (see README "Line history").
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const markets = [...new Set((params.get("markets") ?? "").split(",").filter((id) => MARKET_ID.test(id)))].slice(0, MAX_MARKETS);
  const limit = Math.min(Math.max(Math.floor(Number(params.get("limit"))) || MAX_ROWS, 1), MAX_ROWS);
  const history = getHistory();
  if (!history.enabled) return Response.json({ enabled: false, changes: [] }, { headers: { "Cache-Control": "no-store" } });
  try {
    const changes = await history.forMarkets(markets, { movesOnly: params.has("moves"), limit });
    // Every open page asks for the same recent moves; a few seconds at the CDN absorbs that.
    return Response.json({ enabled: true, changes }, { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30" } });
  } catch (err) {
    console.error("history query failed:", err);
    return Response.json({ enabled: true, changes: [], error: "The history database didn't answer" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
