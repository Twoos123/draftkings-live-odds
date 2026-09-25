// DraftKings endpoints and the NFL "Game Lines" and "1st Half" filters. These are the same
// queries sportsbook.draftkings.com makes for its own NFL page (found via the
// browser's Network tab) — see README "How the data was found".

export const NFL_LEAGUE_ID = "88808";
/** DraftKings subcategory for the main board: moneyline / spread / total. */
export const GAME_LINES_SUBCATEGORY_ID = "4518";
/** The same three markets for the 1st half ("Moneyline 1st Half", ...). */
export const FIRST_HALF_SUBCATEGORY_ID = "4631";

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const dkConfig = {
  /** Jurisdiction for the REST snapshot. Prices can differ slightly by state/province. */
  restSite: env("DK_REST_SITE", "US-NJ-SB"),
  /** Push feed host + jurisdiction; must match restSite (dkusnj <-> US-NJ-SB, dkcaon <-> CA-ON-SB). */
  wsHost: env("DK_WS_HOST", "sportsbook-ws-us-nj.draftkings.com"),
  wsSiteName: env("DK_WS_SITE", "dkusnj"),
};

const eventsFilter = (subcategory: string) => `$filter=leagueId eq '${NFL_LEAGUE_ID}' AND clientMetadata/Subcategories/any(s: s/Id eq '${subcategory}')`;
const marketsFilter = (subcategory: string) => `$filter=clientMetadata/subCategoryId eq '${subcategory}' AND tags/all(t: t ne 'SportcastBetBuilder')`;
// The push feed takes both subcategories in one subscription. The REST endpoint
// doesn't (an OR there is HTTP 400), so the board is two requests; see snapshot.ts.
const FEED_EVENTS_FILTER = `$filter=leagueId eq '${NFL_LEAGUE_ID}' AND clientMetadata/Subcategories/any(s: s/Id eq '${GAME_LINES_SUBCATEGORY_ID}' or s/Id eq '${FIRST_HALF_SUBCATEGORY_ID}')`;
const FEED_MARKETS_FILTER = `$filter=(clientMetadata/subCategoryId eq '${GAME_LINES_SUBCATEGORY_ID}' or clientMetadata/subCategoryId eq '${FIRST_HALF_SUBCATEGORY_ID}') AND tags/all(t: t ne 'SportcastBetBuilder')`;
// The push feed also carries markets for other DK products; OSB = online sportsbook.
const OSB_ONLY = ` and tags/any(t: t eq 'OSB')`;

/** One subcategory of the NFL board (game lines by default). */
export function snapshotUrl(subcategory = GAME_LINES_SUBCATEGORY_ID): string {
  const params = new URLSearchParams({
    isBatchable: "false",
    templateVars: NFL_LEAGUE_ID,
    eventsQuery: eventsFilter(subcategory),
    marketsQuery: marketsFilter(subcategory),
    include: "Events",
    entity: "events",
  });
  // DK's OData-style filters expect %20, not "+", for spaces.
  const query = params.toString().replace(/\+/g, "%20");
  return `https://sportsbook-nash.draftkings.com/sites/${dkConfig.restSite}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${query}`;
}

export function wsUrl(): string {
  return `wss://${dkConfig.wsHost}/websocket?format=json&locale=en`;
}

/**
 * JSON-RPC subscribe message for the push feed. The feed needs no token or
 * cookie: DK's own web client sends `jwt: "default-token"` for anonymous
 * users, and the server accepts the subscription without it.
 */
export function subscribeMessage(id: string) {
  return {
    jsonrpc: "2.0",
    method: "subscribe",
    id,
    params: {
      entity: "events",
      siteName: dkConfig.wsSiteName,
      queryParams: {
        query: FEED_EVENTS_FILTER + OSB_ONLY,
        includeMarkets: FEED_MARKETS_FILTER + OSB_ONLY,
        initialData: false,
        projection: "sportsbook",
        locale: "en",
      },
    },
  };
}
