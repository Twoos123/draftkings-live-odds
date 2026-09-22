import "server-only";
import { randomUUID } from "node:crypto";
import { createSinkFromEnv } from "./clickhouse";
import { DkFeed } from "./dk/feed";
import { fetchSnapshot } from "./dk/snapshot";
import { OddsHub } from "./hub";

const globalForHub = globalThis as typeof globalThis & { __oddsHub?: OddsHub };

/**
 * The instance-wide hub. Kept on globalThis so every route bundle (and dev
 * hot reloads) share one DraftKings connection per process.
 */
export function getHub(): OddsHub {
  globalForHub.__oddsHub ??= new OddsHub({
    fetchSnapshot: (onIssue) => fetchSnapshot(onIssue),
    createFeed: (handlers) => new DkFeed(handlers),
    sink: createSinkFromEnv(),
    now: Date.now,
    instanceId: randomUUID().slice(0, 8),
  });
  return globalForHub.__oddsHub;
}
