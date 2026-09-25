import { describe, expect, it } from "vitest";
import { FIRST_HALF_SUBCATEGORY_ID, GAME_LINES_SUBCATEGORY_ID, snapshotUrl, subscribeMessage } from "@/lib/dk/config";

// These are DraftKings' own queries; a typo means an empty board or a 400, so pin them exactly.

describe("DraftKings REST board", () => {
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it("asks for one subcategory per request (DraftKings rejects an OR here)", () => {
    expect(GAME_LINES_SUBCATEGORY_ID).toBe("4518");
    expect(FIRST_HALF_SUBCATEGORY_ID).toBe("4631");
    expect(params(snapshotUrl(FIRST_HALF_SUBCATEGORY_ID))).toEqual({
      isBatchable: "false",
      templateVars: "88808",
      eventsQuery: "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4631')",
      marketsQuery: "$filter=clientMetadata/subCategoryId eq '4631' AND tags/all(t: t ne 'SportcastBetBuilder')",
      include: "Events",
      entity: "events",
    });
  });

  it("keeps the game-lines request as it was", () => {
    const url = snapshotUrl();
    expect(url).toBe(snapshotUrl(GAME_LINES_SUBCATEGORY_ID));
    expect(url.startsWith("https://sportsbook-nash.draftkings.com/sites/US-NJ-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?")).toBe(true);
    expect(params(url).marketsQuery).toBe("$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder')");
    // DK's filters want %20 for spaces, not "+".
    expect(url).not.toContain("+");
    expect(url).toContain("%20");
  });
});

describe("DraftKings push feed subscription", () => {
  it("covers game lines and 1st-half lines in one subscription", () => {
    const { queryParams } = subscribeMessage("id-1").params;
    expect(queryParams.query).toBe(
      "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4518' or s/Id eq '4631') and tags/any(t: t eq 'OSB')",
    );
    expect(queryParams.includeMarkets).toBe(
      "$filter=(clientMetadata/subCategoryId eq '4518' or clientMetadata/subCategoryId eq '4631') AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')",
    );
  });
});
