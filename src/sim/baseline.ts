import type { MetricName, Service, Source } from "./types.js";

/** All metric values for one minute, per service. Effects mutate this. */
export type MinuteMetrics = Record<Service, Record<MetricName, number>>;

/** 2026-03-14T12:00:00Z — fixed so every run starts at the same instant. */
export const SIM_EPOCH_MS = Date.UTC(2026, 2, 14, 12, 0, 0);
export const MINUTE_MS = 60_000;

const ZERO: Record<MetricName, number> = {
  latency_p50_ms: 0,
  latency_p95_ms: 0,
  error_rate: 0,
  rps: 0,
  cpu_pct: 0,
  mem_pct: 0,
  disk_pct: 0,
  db_pool_in_use: 0,
  db_connections: 0,
  db_query_p95_ms: 0,
  restarts: 0,
};

/** Healthy steady-state values. Incidents add deltas on top of these. */
export const BASELINE: MinuteMetrics = {
  api: {
    ...ZERO,
    latency_p50_ms: 40,
    latency_p95_ms: 120,
    error_rate: 0.004,
    rps: 300,
    cpu_pct: 35,
    mem_pct: 45,
  },
  payments: {
    ...ZERO,
    latency_p50_ms: 60,
    latency_p95_ms: 180,
    error_rate: 0.003,
    rps: 120,
    cpu_pct: 30,
    mem_pct: 50,
    db_pool_in_use: 12,
  },
  database: {
    ...ZERO,
    error_rate: 0.001,
    rps: 900,
    cpu_pct: 40,
    mem_pct: 60,
    disk_pct: 62,
    db_connections: 60,
    db_query_p95_ms: 25,
  },
};

/** Metrics each source reports for each service. */
export const REPORTED_METRICS: Partial<Record<Source, Partial<Record<Service, MetricName[]>>>> = {
  prometheus: {
    api: ["latency_p50_ms", "latency_p95_ms", "error_rate", "rps", "cpu_pct", "mem_pct", "restarts"],
    payments: [
      "latency_p50_ms",
      "latency_p95_ms",
      "error_rate",
      "rps",
      "cpu_pct",
      "mem_pct",
      "db_pool_in_use",
      "restarts",
    ],
    database: [
      "error_rate",
      "rps",
      "cpu_pct",
      "mem_pct",
      "disk_pct",
      "db_connections",
      "db_query_p95_ms",
      "restarts",
    ],
  },
  // A second, independent view of the database host. Lets Phase 8 test
  // cross-source agreement and catch a source with a skewed clock.
  "db-agent": {
    database: ["cpu_pct", "mem_pct", "disk_pct", "db_connections"],
  },
};

/** Relative noise amplitude per metric (value * (1 ± noise)). */
export const NOISE: Record<MetricName, number> = {
  latency_p50_ms: 0.08,
  latency_p95_ms: 0.12,
  error_rate: 0.3,
  rps: 0.06,
  cpu_pct: 0.06,
  mem_pct: 0.02,
  disk_pct: 0.003,
  db_pool_in_use: 0.15,
  db_connections: 0.08,
  db_query_p95_ms: 0.15,
  restarts: 0,
};

export const INITIAL_VERSIONS: Record<Service, string> = {
  api: "5.1.0",
  payments: "2.3.0",
  database: "schema-142",
};

export const INITIAL_CONFIG = {
  "payments.db_pool_max": 50,
} as const;

export const INITIAL_FLAGS: Record<string, boolean> = {
  "api.new_checkout_banner": false,
  "payments.aggressive_retries": false,
  "payments.gateway_fallback": false,
};

export function cloneMetrics(m: MinuteMetrics): MinuteMetrics {
  return { api: { ...m.api }, payments: { ...m.payments }, database: { ...m.database } };
}
