import { getHub } from "@/lib/server";

// Vercel Hobby caps a function at 300s. Each browser stream ends a little
// before that and the browser's EventSource reconnects on its own; with Fluid
// compute the reconnect usually lands on the same warm instance and hub.
export const maxDuration = 300;
const STREAM_LIFETIME_MS = (maxDuration - 20) * 1000;

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
      write(encoder.encode("retry: 1000\n\n"));
      // The hub hands every viewer the same pre-encoded frame.
      const unsubscribe = hub.subscribe((_msg, frame) => write(frame));
      const lifetime = setTimeout(() => {
        write(encoder.encode("event: bye\ndata: {}\n\n"));
        close();
      }, STREAM_LIFETIME_MS);
      close = () => {
        if (closed) return;
        closed = true;
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
