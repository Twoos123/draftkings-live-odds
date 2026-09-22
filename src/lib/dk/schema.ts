import { z } from "zod";

// Raw DraftKings shapes — only the fields we use. Everything except `id` is
// optional because the push feed sends *partial* objects in `change` (e.g. a
// market change carries isSuspended but not eventId). Unknown fields are
// stripped. Entities that fail validation are dropped one at a time, so one
// odd record never takes down the whole board.

const Id = z.union([z.string(), z.number()]).transform(String);

const Participant = z.object({
  id: Id,
  name: z.string(),
  venueRole: z.string().optional(),
  metadata: z.object({ shortName: z.string().optional(), teamColor: z.string().optional() }).optional(),
});

export const DkEventSchema = z.object({
  id: Id,
  name: z.string().optional(),
  startEventDate: z.string().optional(),
  status: z.string().optional(),
  participants: z.array(Participant).optional(),
});

export const DkMarketSchema = z.object({
  id: Id,
  eventId: Id.optional(),
  name: z.string().optional(),
  marketType: z.object({ name: z.string().optional() }).optional(),
  isSuspended: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

export const DkSelectionSchema = z.object({
  id: Id,
  marketId: Id.optional(),
  label: z.string().optional(),
  displayOdds: z.object({ american: z.string().optional(), decimal: z.string().optional() }).optional(),
  trueOdds: z.number().optional(),
  points: z.number().nullish(),
  outcomeType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sortOrder: z.number().optional(),
  /** Set when a line moves: DK issues a new selection id and points at the old one. */
  replacedSelectionId: Id.optional(),
});

export type DkEvent = z.output<typeof DkEventSchema>;
export type DkMarket = z.output<typeof DkMarketSchema>;
export type DkSelection = z.output<typeof DkSelectionSchema>;

export interface DkSnapshot {
  events: DkEvent[];
  markets: DkMarket[];
  selections: DkSelection[];
}

export interface DkEntityDelta {
  events: DkEvent[];
  markets: DkMarket[];
  selections: DkSelection[];
}

export interface DkDelta {
  add: DkEntityDelta;
  change: DkEntityDelta;
  remove: { events: string[]; markets: string[]; selections: string[] };
}

/** DraftKings' own timestamps for an update, used to measure latency. */
export interface DkUpdateMeta {
  /** When DK's trading system created the change. */
  createdTime: string | null;
  /** When DK published it to the push feed. */
  publishedTime: string | null;
  /** When DK's websocket server sent it to us. */
  wsPublishedTime: string | null;
}

export type ParseIssue = (where: string, detail: string) => void;

function parseEntities<S extends z.ZodType>(schema: S, input: unknown, where: string, onIssue?: ParseIssue): z.output<S>[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    onIssue?.(where, "expected an array");
    return [];
  }
  const out: z.output<S>[] = [];
  for (const item of input) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else onIssue?.(where, r.error.issues[0]?.message ?? "invalid");
  }
  return out;
}

function parseIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x) => typeof x === "string" || typeof x === "number").map(String);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class UnexpectedShapeError extends Error {}

export function parseSnapshot(json: unknown, onIssue?: ParseIssue): DkSnapshot {
  if (!isRecord(json) || !Array.isArray(json.events) || !Array.isArray(json.markets) || !Array.isArray(json.selections)) {
    throw new UnexpectedShapeError("DraftKings snapshot is missing events/markets/selections");
  }
  return {
    events: parseEntities(DkEventSchema, json.events, "snapshot.events", onIssue),
    markets: parseEntities(DkMarketSchema, json.markets, "snapshot.markets", onIssue),
    selections: parseEntities(DkSelectionSchema, json.selections, "snapshot.selections", onIssue),
  };
}

function parseEntityDelta(input: unknown, where: string, onIssue?: ParseIssue): DkEntityDelta {
  const r = isRecord(input) ? input : {};
  return {
    events: parseEntities(DkEventSchema, r.events, `${where}.events`, onIssue),
    markets: parseEntities(DkMarketSchema, r.markets, `${where}.markets`, onIssue),
    selections: parseEntities(DkSelectionSchema, r.selections, `${where}.selections`, onIssue),
  };
}

export type WsMessage =
  /** `dkTime`: DraftKings' clock when it acknowledged, used to estimate clock offset. */
  | { kind: "subscribed"; id: string | null; dkTime: string | null }
  | { kind: "update"; delta: DkDelta; meta: DkUpdateMeta }
  | { kind: "error"; message: string }
  | { kind: "other"; event: string }
  | { kind: "invalid"; reason: string };

function str(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

/**
 * Parses one push-feed frame. Update frames look like:
 * { event: "update", data: { data: { add, change, remove }, metadata: {...} }, websocketPublishTimestamp }
 */
export function parseWsMessage(raw: string, onIssue?: ParseIssue): WsMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (!isRecord(msg) || typeof msg.event !== "string") return { kind: "invalid", reason: "missing event" };

  switch (msg.event) {
    case "subscribed":
      return { kind: "subscribed", id: str(msg.id), dkTime: str(msg.websocketPublishTimestamp) };
    case "update": {
      const outer = isRecord(msg.data) ? msg.data : null;
      const body = outer && isRecord(outer.data) ? outer.data : null;
      if (!body) return { kind: "invalid", reason: "update without data" };
      const meta = outer && isRecord(outer.metadata) ? outer.metadata : {};
      const remove = isRecord(body.remove) ? body.remove : {};
      return {
        kind: "update",
        delta: {
          add: parseEntityDelta(body.add, "add", onIssue),
          change: parseEntityDelta(body.change, "change", onIssue),
          remove: { events: parseIds(remove.events), markets: parseIds(remove.markets), selections: parseIds(remove.selections) },
        },
        meta: {
          createdTime: str(meta.createdTime),
          publishedTime: str(meta.publishedTime),
          wsPublishedTime: str(msg.websocketPublishTimestamp),
        },
      };
    }
    case "error":
      return { kind: "error", message: str(msg.data) ?? JSON.stringify(msg.data ?? msg).slice(0, 300) };
    default:
      return { kind: "other", event: msg.event };
  }
}
