"use client";

import { useEffect, useState } from "react";

/**
 * Current time, re-rendering every `intervalMs` (for "12s ago" labels and
 * fading highlights). Pass null to stop ticking.
 */
export function useNow(intervalMs: number | null = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
