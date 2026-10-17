import type { MetricName } from "../sim/types.js";

export interface Point {
  t: number;
  value: number;
}

/**
 * How far a value must move from baseline to count as a deviation: at least
 * `abs` in absolute terms AND at least 30% relative to the baseline. The
 * absolute floors sit well above each metric's simulated noise, so a noisy
 * minute isn't an anomaly.
 */
const MIN_DELTA: Record<MetricName, number> = {
  latency_p50_ms: 50,
  latency_p95_ms: 150,
  error_rate: 0.02,
  rps: 40,
  cpu_pct: 15,
  mem_pct: 15,
  disk_pct: 10,
  db_pool_in_use: 8,
  db_connections: 25,
  db_query_p95_ms: 100,
  restarts: 0.5,
};
const MIN_RELATIVE = 0.3;
/** A deviation must last this many consecutive points to count. */
export const SUSTAINED_POINTS = 3;
/** ...unless it is still going at the end of the window; then this many suffice. */
export const ONGOING_POINTS = 2;

/** Counters where any non-zero value is notable, rather than drift from baseline. */
export const EVENT_METRICS = new Set<MetricName>(["restarts"]);

export type SeriesVerdict =
  | { kind: "anomaly"; direction: "up" | "down"; baseline: number; peak: number; latest: number; onset: number }
  | { kind: "normal"; baseline: number; latest: number }
  | { kind: "events"; count: number; times: number[] }
  | { kind: "insufficient" };

/**
 * Classify one source's series for one metric. Baseline is the median of the
 * first third of the window (before most incidents start). An anomaly is a
 * run of SUSTAINED_POINTS deviating points; we report its onset and the
 * most deviant value anywhere after it. Looking at the peak, not just the
 * latest point, matters for sawtooth signals like a leak that was just
 * OOM-killed back to normal.
 */
export function analyseSeries(metric: MetricName, points: readonly Point[]): SeriesVerdict {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (EVENT_METRICS.has(metric)) {
    const hits = sorted.filter((p) => p.value > 0);
    return { kind: "events", count: hits.reduce((n, p) => n + p.value, 0), times: hits.map((p) => p.t) };
  }
  if (sorted.length < SUSTAINED_POINTS * 3) return { kind: "insufficient" };

  const baseline = median(sorted.slice(0, Math.floor(sorted.length / 3)).map((p) => p.value));
  const latest = sorted.at(-1)?.value ?? baseline;
  const deviates = (v: number) =>
    Math.abs(v - baseline) >= MIN_DELTA[metric] && Math.abs(v - baseline) >= MIN_RELATIVE * Math.abs(baseline);

  let runStart = -1;
  for (let i = 0; i < sorted.length; i++) {
    const value = sorted[i]?.value ?? baseline;
    if (!deviates(value)) {
      runStart = -1;
      continue;
    }
    if (runStart === -1) runStart = i;
    const length = i - runStart + 1;
    // A run that reaches the newest point is still in progress, not a
    // passing spike, so it counts sooner (memory-leak alerts one minute
    // after its OOM kill: only two bad points exist yet).
    const ongoing = i === sorted.length - 1 && length >= ONGOING_POINTS;
    if (length >= SUSTAINED_POINTS || ongoing) {
      const after = sorted.slice(runStart);
      const peak = after.reduce((best, p) => (Math.abs(p.value - baseline) > Math.abs(best - baseline) ? p.value : best), baseline);
      return {
        kind: "anomaly",
        direction: peak >= baseline ? "up" : "down",
        baseline,
        peak,
        latest,
        onset: sorted[runStart]?.t ?? 0,
      };
    }
  }
  return { kind: "normal", baseline, latest };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
