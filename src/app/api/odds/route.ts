import { getHub } from "@/lib/server";

/**
 * The current board as JSON, for scripts and anyone without SSE.
 * Served from the live hub when this instance has one; otherwise fetched
 * from DraftKings (at most 5s old). `?fresh=1` always re-fetches.
 */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.has("fresh");
  const { games, status } = await getHub().getBoard(fresh ? 0 : 5_000);
  return Response.json(
    { asOf: status.lastSnapshotAt, health: status.health, error: status.snapshotError, games },
    { status: games.length === 0 && status.health === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
