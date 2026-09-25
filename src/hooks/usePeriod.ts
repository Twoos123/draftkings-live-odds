"use client";

import { PERIODS, type Period } from "@/lib/odds/types";
import { createStoredChoice } from "./useStoredChoice";

/** Full game or 1st half, for the whole page; remembered per browser. The server always renders "full". */
export const usePeriod = createStoredChoice<Period>("oddsPeriod", PERIODS, "full");
