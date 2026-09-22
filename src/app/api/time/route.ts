import { getHub } from "@/lib/server";

/**
 * Current time on DraftKings' clock (our clock plus the offset measured on the
 * push feed), so the browser can line its own clock up with DK's timestamps.
 */
export async function GET() {
  return Response.json({ now: getHub().now() }, { headers: { "Cache-Control": "no-store" } });
}
