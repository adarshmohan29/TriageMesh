/**
 * Deterministic, readable ids ("ev-0003") from per-prefix counters. Random
 * UUIDs would make reports and snapshots differ between identical runs.
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export function createIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${String(n).padStart(4, "0")}`;
    },
  };
}
