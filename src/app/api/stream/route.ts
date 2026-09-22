import { getHub } from "@/lib/server";

// Vercel Hobby caps a function at 300s, so each browser stream is recycled
// before that. With Fluid compute the new stream usually lands on the same
// warm instance and hub.
export const maxDuration = 300;
/** Override only to watch rotation locally without waiting ~5 minutes. */
const STREAM_LIFETIME_MS = Number(process.env.STREAM_LIFETIME_MS) || (maxDuration - 20) * 1000;
/**
 * Warn the browser this long before closing, so it opens the next stream
 * first and switches over with no gap (instead of a reconnect blind spot).
 */
const ROTATE_NOTICE_MS = 10_000;

/**
 * Server-Sent Events: DraftKings' push updates (`delta`), relayed as they
 * arrive, plus a `status` heartbeat every few seconds. On connect, the last
 * ~10s of deltas are replayed so a freshly loaded board can catch up.
 */
export async function GET(req: Request) {
  const hub = getHub();
  const encoder = new TextEncoder();
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (bytes: Uint8Array) => {
        if (!closed) controller.enqueue(bytes);
      };
      // Unplanned drops: have EventSource retry quickly.
      write(encoder.encode("retry: 250\n\n"));
      // The hub hands every viewer the same pre-encoded frame.
      const unsubscribe = hub.subscribe((_msg, frame) => write(frame));
      const rotate = setTimeout(() => write(encoder.encode("event: rotate\ndata: {}\n\n")), STREAM_LIFETIME_MS - ROTATE_NOTICE_MS);
      const lifetime = setTimeout(() => close(), STREAM_LIFETIME_MS);
      close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(rotate);
        clearTimeout(lifetime);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", () => close());
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
