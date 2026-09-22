import { getHub } from "@/lib/server";

/** Feed status for this instance: connection state, freshness, latency, counters. */
export async function GET() {
  return Response.json(getHub().status(), { headers: { "Cache-Control": "no-store" } });
}
