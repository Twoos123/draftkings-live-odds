"use client";

import { useSyncExternalStore } from "react";
import type { OddsFormat } from "@/lib/odds/format";

// American/decimal preference, remembered per browser, with an in-memory
// fallback when storage is blocked. The server always renders "american".
const listeners = new Set<() => void>();
let inMemory: OddsFormat | null = null;

function read(): OddsFormat {
  if (inMemory) return inMemory;
  try {
    return localStorage.getItem("oddsFormat") === "decimal" ? "decimal" : "american";
  } catch {
    return "american";
  }
}

export function useOddsFormat(): [OddsFormat, (f: OddsFormat) => void] {
  const format = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    () => "american" as const,
  );
  const update = (f: OddsFormat) => {
    inMemory = f;
    try {
      localStorage.setItem("oddsFormat", f);
    } catch {
      // storage unavailable: the in-memory value still applies
    }
    listeners.forEach((l) => l());
  };
  return [format, update];
}
