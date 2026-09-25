import { describe, expect, it } from "vitest";
import { PERIODS } from "@/lib/odds/types";
import { parseChoice } from "@/lib/storedChoice";

describe("parseChoice (remembered toggles)", () => {
  it("keeps a stored value that's still a choice", () => {
    expect(parseChoice("half", PERIODS, "full")).toBe("half");
    expect(parseChoice("full", PERIODS, "full")).toBe("full");
    expect(parseChoice("decimal", ["american", "decimal"], "american")).toBe("decimal");
  });

  it("falls back when nothing is stored, or it's garbage from an old version or another site", () => {
    expect(parseChoice(null, PERIODS, "full")).toBe("full");
    expect(parseChoice(undefined, PERIODS, "full")).toBe("full");
    expect(parseChoice("", PERIODS, "full")).toBe("full");
    expect(parseChoice("banana", PERIODS, "full")).toBe("full");
    expect(parseChoice("HALF", PERIODS, "full")).toBe("full");
    expect(parseChoice("toString", PERIODS, "full")).toBe("full");
  });
});
