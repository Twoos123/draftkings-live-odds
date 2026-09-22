/**
 * Feed audit: does DraftKings' push feed deliver every change the REST board shows?
 *
 *   npm run audit            # 15 minutes
 *   npm run audit -- 60      # 60 minutes
 *
 * Keeps one board updated ONLY from the push feed (never re-synced) using the
 * app's own subscription, store and normalizer. Every 5s it compares that board
 * with a fresh REST snapshot. A difference that persists across two polls is a
 * missed update: the push path disagrees with DraftKings. Prints a summary at
 * the end; exit code 1 if anything was missed.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { subscribeMessage, wsUrl } from "../src/lib/dk/config";
import { parseWsMessage, type DkDelta } from "../src/lib/dk/schema";
import { fetchSnapshot } from "../src/lib/dk/snapshot";
import { normalizeGames } from "../src/lib/odds/normalize";
import { DkStore } from "../src/lib/odds/store";

const minutes = Number(process.argv[2] ?? 15);
const POLL_MS = 5_000;

const t = () => new Date().toISOString().slice(11, 23);
const log = (...parts: unknown[]) => console.log(t(), ...parts);

/** "ATL Falcons @ GB Packers | spread away" -> "+6 -108" (or "locked" when suspended). */
function flatten(store: DkStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of normalizeGames(store).values()) {
    for (const m of Object.values(g.markets)) {
      for (const s of m!.selections) {
        out.set(`${g.name} | ${m!.type} ${s.side}`, `${s.line ?? ""} ${s.american}${m!.suspended ? " (locked)" : ""}`.trim());
      }
    }
  }
  return out;
}

let pushStore: DkStore | null = null;
const early: DkDelta[] = [];
let pushUpdates = 0;
let pushPriceChanges = 0;

function connect() {
  const ws = new WebSocket(wsUrl(), { handshakeTimeout: 10_000 });
  ws.on("open", () => ws.send(JSON.stringify(subscribeMessage(randomUUID()))));
  ws.on("message", async (data) => {
    const msg = parseWsMessage(data.toString());
    if (msg.kind === "subscribed") {
      log("push feed subscribed");
      if (!pushStore) {
        const store = DkStore.fromSnapshot(await fetchSnapshot());
        for (const d of early) store.apply(d);
        pushStore = store;
        log(`baseline snapshot: ${store.events.size} games`);
      }
      return;
    }
    if (msg.kind !== "update") return;
    pushUpdates++;
    if (!pushStore) {
      early.push(msg.delta);
      return;
    }
    const before = flatten(pushStore);
    pushStore.apply(msg.delta);
    const after = flatten(pushStore);
    for (const [k, v] of after) {
      if (before.get(k) !== v) {
        pushPriceChanges++;
        log(`PUSH  ${k}: ${before.get(k) ?? "-"} -> ${v}  (DK created ${msg.meta.createdTime?.slice(11, 23)})`);
      }
    }
  });
  ws.on("close", () => {
    // A gap in the push feed would invalidate the audit, so say so loudly.
    log("PUSH FEED CLOSED: results after this point include the reconnect gap; reconnecting");
    setTimeout(connect, 1_000);
  });
  ws.on("error", (e) => log("push feed error:", e.message));
}

const pending = new Map<string, { rest: string; push: string | undefined; since: string }>();
const misses: { key: string; rest: string; push: string | undefined; since: string }[] = [];
let restPrev: Map<string, string> | null = null;
let restChanges = 0;
let polls = 0;

async function poll() {
  if (!pushStore) return;
  let rest: Map<string, string>;
  try {
    rest = flatten(DkStore.fromSnapshot(await fetchSnapshot()));
  } catch (e) {
    log("REST error:", (e as Error).message);
    return;
  }
  polls++;
  const push = flatten(pushStore);
  if (restPrev) {
    for (const [k, v] of rest) {
      if (restPrev.get(k) !== v) {
        restChanges++;
        log(`REST  ${k}: ${restPrev.get(k) ?? "-"} -> ${v}   push board has: ${push.get(k) ?? "-"}`);
      }
    }
  }
  restPrev = rest;

  for (const [k, v] of rest) {
    const p = push.get(k);
    if (p === v) {
      pending.delete(k);
      continue;
    }
    const seen = pending.get(k);
    if (!seen || seen.rest !== v) {
      pending.set(k, { rest: v, push: p, since: t() });
    } else if (!misses.some((m) => m.key === k && m.rest === v)) {
      // Still different a full poll later: not just the 1s CDN cache or an in-flight push.
      misses.push({ key: k, rest: v, push: p, since: seen.since });
      log(`MISS  ${k}: REST says ${v}, push board says ${p ?? "-"} (since ${seen.since})`);
    }
  }
}

function summary() {
  const result = { minutes, polls, pushUpdates, pushPriceChanges, restObservedChanges: restChanges, missed: misses.length, misses };
  console.log("\n=== feed audit ===\n" + JSON.stringify(result, null, 2));
  process.exit(misses.length ? 1 : 0);
}

process.on("unhandledRejection", (e) => log("unhandled:", e));
log(`auditing for ${minutes} min: push feed vs REST every ${POLL_MS / 1000}s`);
connect();
setInterval(() => void poll(), POLL_MS);
setInterval(() => log(`… ${polls} polls, ${pushUpdates} push updates, ${pushPriceChanges} push price changes, ${restChanges} REST-observed changes, ${misses.length} missed`), 60_000);
setTimeout(summary, minutes * 60_000);
