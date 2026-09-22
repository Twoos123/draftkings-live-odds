import { getHub } from "@/lib/server";

/**
 * The server's own copy of the board as JSON (at most 5s old; `?fresh=1`
 * re-fetches). Works where DraftKings' REST endpoint accepts the server's IP.
 * On Vercel, Akamai blocks it, so this returns 503 with the reason; the page
 * itself loads the board in the browser instead.
 */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.has("fresh");
  const { games, asOf, error } = await getHub().getBoard(fresh ? 0 : 5_000);
  return Response.json(
    { asOf, error, games },
    { status: games.length === 0 && error ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
