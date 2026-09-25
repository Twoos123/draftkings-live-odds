"use client";

import type { OddsFormat } from "@/lib/odds/format";
import { createStoredChoice } from "./useStoredChoice";

/** American/decimal preference, remembered per browser. The server always renders "american". */
export const useOddsFormat = createStoredChoice<OddsFormat>("oddsFormat", ["american", "decimal"], "american");
