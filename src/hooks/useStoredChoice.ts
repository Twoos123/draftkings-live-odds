"use client";

import { useSyncExternalStore } from "react";
import { parseChoice } from "@/lib/storedChoice";

/**
 * A hook for one preference, remembered per browser in localStorage under
 * `key`, with an in-memory fallback when storage is blocked. Anything stored
 * that isn't one of `allowed` reads as `fallback`. The server always renders
 * `fallback`; the stored choice applies after hydration. Other tabs follow.
 */
export function createStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): () => [T, (value: T) => void] {
  const listeners = new Set<() => void>();
  let inMemory: T | null = null;

  function read(): T {
    if (inMemory) return inMemory;
    try {
      return parseChoice(localStorage.getItem(key), allowed, fallback);
    } catch {
      return fallback;
    }
  }

  function subscribe(onChange: () => void) {
    listeners.add(onChange);
    // Another tab changed it (or cleared storage): storage is the truth again.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== key) return;
      inMemory = null;
      onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }

  function update(value: T) {
    inMemory = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage unavailable: the in-memory value still applies
    }
    listeners.forEach((l) => l());
  }

  return function useStoredChoice() {
    const value = useSyncExternalStore(subscribe, read, () => fallback);
    return [value, update];
  };
}
