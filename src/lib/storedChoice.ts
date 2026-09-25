/** A remembered preference, or `fallback` if it's missing or no longer one of the choices. */
export function parseChoice<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
