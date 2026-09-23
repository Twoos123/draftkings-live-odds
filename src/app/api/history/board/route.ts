import { z } from "zod";
import { getHub } from "@/lib/server";

const BoardSide = z.object({
  marketId: z.string().regex(/^\d+_\d+$/),
  selectionId: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  line: z.number().min(-500).max(500).nullable(),
  american: z.number().int().min(-1_000_000).max(1_000_000).refine((a) => Math.abs(a) >= 100),
  decimal: z.number().gt(1).max(10_001),
});
const Board = z.array(BoardSide).max(2000);

/**
 * A browser's copy of the board, which it loaded from DraftKings itself. Sent
 * when the server asks (status.history.needsBoard) because DraftKings won't
 * serve the board to it (Vercel). It only supplies the price *before* each
 * side's first recorded move on the server's current connection; the new
 * price and its time always come from DraftKings' push feed.
 */
export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > 500_000) return Response.json({ error: "too large" }, { status: 413 });
  let parsed;
  try {
    parsed = Board.safeParse(JSON.parse(text));
  } catch {
    return Response.json({ error: "not JSON" }, { status: 400 });
  }
  if (!parsed.success) return Response.json({ error: "not a board" }, { status: 400 });
  const taken = getHub().takeViewerBoard(parsed.data);
  return Response.json({ taken }, { headers: { "Cache-Control": "no-store" } });
}
