import { getHub } from "@/lib/server";

// Vercel Hobby caps a function at 300s. Each browser stream ends a little
// before that and the browser's EventSource reconnects on its own; with Fluid
// compute the reconnect usually lands on the same warm instance and hub.
export const maxDuration = 300;
const STREAM_LIFETIME_MS = (maxDuration - 20) * 1000;

/**
 * Server-Sent Events: a `snapshot` of the board on connect, then `update`s as
 * DraftKings moves lines, and a `status` heartbeat every few seconds.
 * `?resync=1` (the Refresh button) forces a fresh REST check first.
 */
export async function GET(req: Request) {
  const hub = getHub();
  const resync = new URL(req.url).searchParams.has("resync");
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
      const unsubscribe = hub.subscribe((_msg, frame) => write(frame), { resync });
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
