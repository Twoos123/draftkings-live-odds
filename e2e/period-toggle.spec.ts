import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The Full game / 1st half toggle, end to end in a real browser. Nothing here
// reaches DraftKings or our server's feed: DraftKings' REST board is served
// from the recorded fixtures, and the live feed is a stand-in EventSource the
// test pushes updates through, in the same shape /api/stream sends them.

declare global {
  interface Window {
    __sse?: { emit(type: string, data: unknown): void };
  }
}

interface RawBoard {
  events: { id: string; status?: string }[];
  markets: { id: string; eventId: string }[];
  selections: { id: string; marketId: string; displayOdds: { american: string; decimal: string } }[];
}

const fixture = (name: string): RawBoard => JSON.parse(readFileSync(join(__dirname, "..", "test", "fixtures", name), "utf8"));

// LA Chargers @ BUF Bills (Sunday): moneyline LAC +270 for the game, +200 for the 1st half.
const LAC_BUF = "34118212";
const HALF_MARKETS = ["1_86410040", "2_86410040", "3_86410040"];
const FULL_MARKETS = ["1_84695645", "2_84695645", "3_84695645"];
// ATL Falcons @ GB Packers: no 1st-half lines posted when the fixtures were recorded.
const ATL_GB = "34118180";
const GAMES = 32;
const WITH_HALF = 14;

function liveStatus() {
  const now = new Date().toISOString();
  return {
    type: "status",
    sentAt: now,
    status: {
      health: "live",
      serverTime: now,
      dkClockOffsetMs: 0,
      instanceId: "e2e",
      ws: "open",
      subscribed: true,
      subscribedAt: now,
      lastMessageAt: null,
      lastError: null,
      dkToServerMs: null,
      wireMs: null,
      dkInternalMs: null,
      counters: { updates: 0, parseIssues: 0, reconnects: 0 },
      serverBoard: { lastSnapshotAt: null, snapshotError: null, moves: 0, resyncCorrections: 0 },
      sink: { enabled: false, lastError: null, written: 0 },
      history: null,
    },
  };
}

type Delta = {
  add: { events: object[]; markets: object[]; selections: object[] };
  change: { events: object[]; markets: object[]; selections: object[] };
  remove: { events: string[]; markets: string[]; selections: string[] };
};

function deltaOf(part: (d: Delta) => void): Delta {
  const d: Delta = {
    add: { events: [], markets: [], selections: [] },
    change: { events: [], markets: [], selections: [] },
    remove: { events: [], markets: [], selections: [] },
  };
  part(d);
  return d;
}

/** Send one update down the fake live feed, as /api/stream would. */
async function push(page: Page, delta: Delta) {
  const now = new Date().toISOString();
  await page.evaluate((msg) => window.__sse!.emit("delta", msg), { type: "delta", delta, sentAt: now, timing: { dkCreatedAt: now, dkPublishedAt: null, serverReceivedAt: now } });
}

/**
 * Open the board with DraftKings, the live feed and our APIs stood in for.
 * Returns the served DraftKings data (change it to match what you push, so
 * the page's periodic re-check agrees) and the /api/history requests made.
 */
async function open(page: Page, { stored }: { stored?: Record<string, string> } = {}) {
  const board = { full: fixture("nfl-snapshot.json"), half: fixture("nfl-1h-snapshot.json") };
  const historyAsked: string[] = [];

  await page.route(
    (url) => url.hostname === "sportsbook-nash.draftkings.com",
    (route) => {
      const markets = new URL(route.request().url()).searchParams.get("marketsQuery") ?? "";
      const body = markets.includes("'4631'") ? board.half : markets.includes("'4518'") ? board.full : null;
      return body ? route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } }) : route.abort();
    },
  );
  await page.route(
    (url) => url.pathname === "/api/time",
    (route) => route.fulfill({ json: { now: Date.now() } }),
  );
  await page.route(
    (url) => url.pathname === "/api/history",
    (route) => {
      const asked = new URL(route.request().url()).searchParams.get("markets") ?? "";
      historyAsked.push(asked);
      // One recorded 1st-half move for LAC, so the panel has something to place.
      const changes = asked.split(",").includes("1_86410040")
        ? [
            {
              marketId: "1_86410040",
              selectionId: "0ML86410040_3",
              label: "LA Chargers",
              from: { line: null, american: 190, decimal: 2.9 },
              to: { line: null, american: 200, decimal: 3 },
              fromSource: "feed",
              at: new Date(Date.now() - 3_600_000).toISOString(),
            },
          ]
        : [];
      return route.fulfill({ json: { enabled: true, changes } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/history/board",
    (route) => route.fulfill({ json: { taken: 0 } }),
  );
  // Belt and braces: the fake EventSource below never requests it.
  await page.route(
    (url) => url.pathname === "/api/stream",
    (route) => route.abort(),
  );

  await page.addInitScript((status) => {
    type Listener = (e: MessageEvent) => void;
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 0;
      onopen: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();
      private heartbeat: number | undefined;
      constructor(readonly url: string) {
        window.__sse = this;
        setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          this.beat();
          // The page reconnects after 15 s of silence, like with a dead proxy.
          this.heartbeat = window.setInterval(() => this.beat(), 4_000);
        }, 0);
      }
      private beat() {
        const now = new Date().toISOString();
        this.emit("status", { ...status, sentAt: now, status: { ...status.status, serverTime: now } });
      }
      addEventListener(type: string, fn: Listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(fn);
      }
      removeEventListener(type: string, fn: Listener) {
        this.listeners.get(type)?.delete(fn);
      }
      close() {
        this.readyState = 2;
        clearInterval(this.heartbeat);
      }
      emit(type: string, data: unknown) {
        if (this.readyState !== 1) return;
        for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    Object.defineProperty(window, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
  }, liveStatus());

  if (stored) {
    // Seed storage once, as if from an earlier visit (not again on reload).
    await page.addInitScript((values) => {
      if (sessionStorage.getItem("e2e-seeded")) return;
      sessionStorage.setItem("e2e-seeded", "1");
      for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
    }, stored);
  }

  await page.goto("/");
  await expect(page.locator(".game-card")).toHaveCount(GAMES);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  return { board, historyAsked };
}

const periodButton = (page: Page, name: "Full game" | "1st half") => page.getByRole("group", { name: "Game period" }).getByRole("button", { name, exact: true });
const card = (page: Page, id: string) => page.locator(`#game-${id}`);
/** A price cell, found by its tooltip's first line, e.g. "1st half: LA Chargers +200". */
const price = (page: Page, gameId: string, firstLine: string) =>
  card(page, gameId).getByTitle(new RegExp(`^${firstLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
const latestMoves = (page: Page) => page.getByRole("region", { name: /Latest line moves/ });

test("shows the full game by default", async ({ page }) => {
  await open(page);
  await expect(periodButton(page, "Full game")).toHaveAttribute("aria-pressed", "true");
  await expect(periodButton(page, "1st half")).toHaveAttribute("aria-pressed", "false");
  await expect(price(page, LAC_BUF, "LA Chargers +270")).toBeVisible();
  await expect(price(page, ATL_GB, "ATL Falcons +235")).toBeVisible();
  await expect(page.getByText("1st-half lines not posted yet")).toHaveCount(0);
});

test("flips every game to its 1st-half lines, and explains the games without them", async ({ page }, testInfo) => {
  await open(page);
  await periodButton(page, "1st half").click();

  await expect(periodButton(page, "1st half")).toHaveAttribute("aria-pressed", "true");
  await expect(periodButton(page, "Full game")).toHaveAttribute("aria-pressed", "false");
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +4.5 −120")).toBeVisible();
  await expect(price(page, LAC_BUF, "1st half: Over O 25.5 −108")).toBeVisible();
  await expect(price(page, LAC_BUF, "LA Chargers +270")).toHaveCount(0);

  // Every game stays listed; the 18 without 1st-half lines say so instead of showing prices.
  await expect(page.locator(".game-card")).toHaveCount(GAMES);
  await expect(page.getByText("1st-half lines not posted yet")).toHaveCount(GAMES - WITH_HALF);
  await expect(card(page, ATL_GB)).toContainText("1st-half lines not posted yet");
  await expect(card(page, ATL_GB).getByTitle(/Implied chance/)).toHaveCount(0);

  await expect(latestMoves(page)).toContainText("1st half");
  await expect(latestMoves(page)).toContainText("No 1st-half lines have moved yet");
  const header = testInfo.project.name === "phone" ? "1H" : "Game · 1st half";
  await expect(page.getByText(header, { exact: true }).first()).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("1st-half.png") });
  await periodButton(page, "Full game").click();
  await expect(price(page, LAC_BUF, "LA Chargers +270")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("full-game.png") });
});

test("remembers the choice across a reload", async ({ page }) => {
  await open(page);
  await periodButton(page, "1st half").click();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();
  await page.reload();
  await expect(periodButton(page, "1st half")).toHaveAttribute("aria-pressed", "true");
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();
});

test("falls back to the full game when the remembered choice is garbage", async ({ page }) => {
  await open(page, { stored: { oddsPeriod: "banana" } });
  await expect(periodButton(page, "Full game")).toHaveAttribute("aria-pressed", "true");
  await expect(price(page, LAC_BUF, "LA Chargers +270")).toBeVisible();
});

test("shows a live 1st-half move in the 1st half only", async ({ page }) => {
  const { board } = await open(page);
  await periodButton(page, "1st half").click();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();

  // DraftKings moves LAC's 1st-half moneyline +200 -> +220.
  board.half.selections.find((s) => s.id === "0ML86410040_3")!.displayOdds = { american: "+220", decimal: "3.20" };
  await push(page, deltaOf((d) => d.change.selections.push({ id: "0ML86410040_3", displayOdds: { american: "+220", decimal: "3.20" } })));

  const moved = price(page, LAC_BUF, "1st half: LA Chargers +220");
  await expect(moved).toBeVisible();
  await expect(moved.getByLabel("moved up")).toBeVisible();
  await expect(moved.locator("s", { hasText: "+200" })).toBeVisible();
  await expect(latestMoves(page).getByRole("link")).toHaveCount(1);
  await expect(latestMoves(page).getByRole("link").first()).toContainText(/LAC.*\+200.*\+220/);

  // The full game didn't move.
  await periodButton(page, "Full game").click();
  const full = price(page, LAC_BUF, "LA Chargers +270");
  await expect(full).toBeVisible();
  await expect(card(page, LAC_BUF).getByLabel(/moved (up|down)/)).toHaveCount(0);
  await expect(latestMoves(page).getByRole("link")).toHaveCount(0);
  await expect(latestMoves(page)).toContainText("No main lines have moved yet");
});

test("clears a game's 1st half when DraftKings takes it down mid-game, keeping the full game", async ({ page }) => {
  const { board } = await open(page);
  await periodButton(page, "1st half").click();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();

  board.half.markets = board.half.markets.filter((m) => !HALF_MARKETS.includes(m.id));
  board.half.selections = board.half.selections.filter((s) => !HALF_MARKETS.includes(s.marketId));
  for (const b of [board.full, board.half]) for (const e of b.events) if (e.id === LAC_BUF) e.status = "STARTED";
  await push(
    page,
    deltaOf((d) => {
      d.remove.markets.push(...HALF_MARKETS);
      d.change.events.push({ id: LAC_BUF, status: "STARTED" });
    }),
  );

  await expect(card(page, LAC_BUF)).toContainText("No 1st-half lines right now");
  await expect(card(page, LAC_BUF)).toContainText("LIVE");
  await periodButton(page, "Full game").click();
  await expect(price(page, LAC_BUF, "LA Chargers +270")).toBeVisible();
});

test("line history shows the period on the board, and switches with it", async ({ page }) => {
  const { historyAsked } = await open(page);
  await periodButton(page, "1st half").click();

  const lac = card(page, LAC_BUF);
  await lac.getByRole("button", { name: "Line history" }).click();
  await expect(lac.getByText("1st-half moneyline")).toBeVisible();
  await expect(lac.locator(`#history-${LAC_BUF}`)).toContainText(/LAC\s*\+190\s*→\s*\+200/);
  expect(historyAsked).toEqual([HALF_MARKETS.join(",")]);

  // Switching period with the panel open asks about the other period's markets.
  await periodButton(page, "Full game").click();
  await expect(lac.getByText("No line moves recorded for this game yet.")).toBeVisible();
  expect(historyAsked).toEqual([HALF_MARKETS.join(","), FULL_MARKETS.join(",")]);

  // Back to the 1st half: LAC's open panel asks about its 1st half again.
  await periodButton(page, "1st half").click();
  await expect(lac.getByText("1st-half moneyline")).toBeVisible();
  expect(historyAsked).toEqual([HALF_MARKETS.join(","), FULL_MARKETS.join(","), HALF_MARKETS.join(",")]);

  // A game with no 1st-half lines has nothing to ask about, and doesn't claim history is off.
  const atl = card(page, ATL_GB);
  await atl.getByRole("button", { name: "Line history" }).click();
  await expect(atl.locator(`#history-${ATL_GB}`)).toContainText("1st-half lines not posted yet.");
  await expect(atl.locator(`#history-${ATL_GB}`)).not.toContainText("isn't recorded");
  expect(historyAsked).toHaveLength(3);
});

test("works with decimal odds", async ({ page }) => {
  await open(page);
  await periodButton(page, "1st half").click();
  await page.getByRole("group", { name: "Odds format" }).getByRole("button", { name: "Decimal" }).click();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers 3.00")).toBeVisible();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +4.5 1.83")).toBeVisible();
});

test("search still filters in the 1st half", async ({ page }) => {
  await open(page);
  await periodButton(page, "1st half").click();
  await page.getByRole("searchbox", { name: "Search teams" }).fill("Chargers");
  await expect(page.locator(".game-card")).toHaveCount(2);
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();
  await expect(card(page, "34118039")).toContainText("1st-half lines not posted yet"); // LAC @ SEA, next week
});

test("can be switched from the keyboard", async ({ page }) => {
  await open(page);
  await page.getByRole("searchbox", { name: "Search teams" }).focus();
  await page.keyboard.press("Tab");
  await expect(periodButton(page, "Full game")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(periodButton(page, "1st half")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(periodButton(page, "1st half")).toHaveAttribute("aria-pressed", "true");
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();
});

test("fits a phone screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "phone layout");
  await open(page);
  await periodButton(page, "1st half").click();
  await expect(price(page, LAC_BUF, "1st half: LA Chargers +200")).toBeVisible();

  for (const width of [320, 360, 375, 412]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const cut = [...document.querySelectorAll(".game-card .truncate")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
      const spill = [...document.querySelectorAll(".game-card [title*='Implied chance']")].filter((e) => e.scrollWidth > e.clientWidth + 1).length;
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        cut,
        spill,
        search: r("input[type=search]").width,
        toggles: [r("[aria-label='Game period']"), r("[aria-label='Odds format']")].map((b) => ({ left: b.left, right: b.right })),
      };
    });
    expect(layout.pageWidth, `no sideways scroll at ${width}px`).toBeLessThanOrEqual(layout.viewport);
    expect(layout.cut, `team names not cut off at ${width}px`).toEqual([]);
    expect(layout.spill, `prices inside their cells at ${width}px`).toBe(0);
    expect(layout.search, `search box usable at ${width}px`).toBeGreaterThan(200);
    for (const t of layout.toggles) {
      expect(t.left).toBeGreaterThanOrEqual(0);
      expect(t.right).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`phone-${width}.png`) });
  }
});
