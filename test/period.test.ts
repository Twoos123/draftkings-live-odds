import { describe, expect, it } from "vitest";
import { tickMarket } from "@/lib/clickhouse";
import { marketLabel, noLinesText, PERIOD_LABEL } from "@/lib/odds/format";

describe("period labels", () => {
  it("names the toggle's choices and each market", () => {
    expect(PERIOD_LABEL).toEqual({ full: "Full game", half: "1st half" });
    expect(marketLabel("spread", "full")).toBe("Spread");
    expect(marketLabel("moneyline", "half")).toBe("1st-half moneyline");
  });

  it("says why a game has no lines: not posted yet before kickoff, taken down once it's started", () => {
    expect(noLinesText("half", false)).toBe("1st-half lines not posted yet");
    expect(noLinesText("half", true)).toBe("No 1st-half lines right now");
    expect(noLinesText("full", false)).toBe("Lines not posted yet");
    expect(noLinesText("full", true)).toBe("No lines right now");
  });
});

describe("odds_ticks market column", () => {
  it("keeps the full game's values as they were and prefixes the 1st half's", () => {
    expect(tickMarket("full", "moneyline")).toBe("moneyline");
    expect(tickMarket("full", "total")).toBe("total");
    expect(tickMarket("half", "moneyline")).toBe("half_moneyline");
    expect(tickMarket("half", "spread")).toBe("half_spread");
  });
});
