import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshot, mergeSnapshots, SnapshotError } from "@/lib/dk/snapshot";
import { loadHalfSnapshot, loadSnapshot, readFixture } from "./helpers";

// What DraftKings sends for a subcategory with nothing posted (checked live).
const EMPTY = { sports: [], leagues: [], events: [], markets: [], selections: [] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stand in for DraftKings, answering by subcategory; returns the subcategories asked for. */
function stubDraftKings(bySubcategory: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const marketsQuery = new URL(String(input)).searchParams.get("marketsQuery") ?? "";
      const sub = /subCategoryId eq '(\d+)'/.exec(marketsQuery)?.[1] ?? "?";
      asked.push(sub);
      return bySubcategory[sub]();
    }),
  );
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSnapshot", () => {
  it("loads game lines and 1st-half lines together as one board", async () => {
    const asked = stubDraftKings({ "4518": () => json(readFixture("nfl-snapshot.json")), "4631": () => json(readFixture("nfl-1h-snapshot.json")) });
    const board = await fetchSnapshot();
    expect(asked.sort()).toEqual(["4518", "4631"]);
    expect(board.events).toHaveLength(32); // the 14 games in both are listed once
    expect(board.markets).toHaveLength(96 + 42);
    expect(board.selections).toHaveLength(192 + 84);
  });

  it("is fine with no 1st-half lines posted", async () => {
    stubDraftKings({ "4518": () => json(readFixture("nfl-snapshot.json")), "4631": () => json(EMPTY) });
    const board = await fetchSnapshot();
    expect(board.events).toHaveLength(32);
    expect(board.markets).toHaveLength(96);
  });

  it("fails, rather than load half a board, when the 1st-half request fails", async () => {
    stubDraftKings({ "4518": () => json(readFixture("nfl-snapshot.json")), "4631": () => json({ error: "oops" }, 500) });
    await expect(fetchSnapshot()).rejects.toThrow(new SnapshotError("1st-half lines: DraftKings snapshot returned HTTP 500"));
  });

  it("names the game-lines failure when both fail, whichever answered first", async () => {
    stubDraftKings({
      "4518": () => new Promise((r) => setTimeout(() => r(json({}, 403)), 20)),
      "4631": () => json({}, 500),
    });
    await expect(fetchSnapshot()).rejects.toThrow("DraftKings snapshot returned HTTP 403 (blocked by Akamai)");
  });

  it("says what went wrong with a 1st-half response it can't use", async () => {
    stubDraftKings({ "4518": () => json(readFixture("nfl-snapshot.json")), "4631": () => json({ unexpected: true }) });
    await expect(fetchSnapshot()).rejects.toThrow("1st-half lines: DraftKings snapshot is missing events/markets/selections");

    stubDraftKings({
      "4518": () => json(readFixture("nfl-snapshot.json")),
      "4631": () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(fetchSnapshot()).rejects.toThrow("1st-half lines: DraftKings unreachable: TypeError: fetch failed");
  });
});

describe("mergeSnapshots", () => {
  it("keeps one copy of each entity, the first one's", () => {
    const full = loadSnapshot();
    const half = loadHalfSnapshot();
    half.events[0] = { ...half.events[0], name: "renamed in the 1st-half response" };
    const merged = mergeSnapshots(full, half);
    const id = half.events[0].id;
    expect(merged.events.filter((e) => e.id === id)).toEqual([full.events.find((e) => e.id === id)]);
    expect(new Set(merged.markets.map((m) => m.id)).size).toBe(merged.markets.length);
  });
});
