import type { IncidentScript } from "../incident.js";

export const missingIndex: IncidentScript = {
  id: "missing-index",
  title: "Schema migration drops the index behind every charge lookup",
  description:
    "Migration 143 removes 'unused' indexes, including the one on charges.merchant_id. " +
    "Queries fall back to sequential scans and latency climbs up the whole stack.",
  onsetMinute: 75,
  alert: {
    title: "API p95 latency above 1.5s",
    service: "api",
    metric: "latency_p95_ms",
    comparator: ">",
    threshold: 1500,
    minute: 80,
  },
  rootCause: {
    kind: "schema_migration",
    service: "database",
    ref: "dep-db-schema-143",
    summary: "migration 143 dropped idx_charges_merchant_id, forcing sequential scans",
    remediations: [{ tool: "deploy.rollback", args: { service: "database" } }],
  },
  timeline: [
    {
      minute: 72,
      kind: "flag",
      id: "flag-banner-on",
      flag: "api.new_checkout_banner",
      enabled: true,
      previous: false,
      actor: "growth-team",
    },
    {
      minute: 75,
      kind: "deploy",
      id: "dep-db-schema-143",
      service: "database",
      version: "schema-143",
      previousVersion: "schema-142",
      changeType: "migration",
      description: "Migration 143: drop unused legacy indexes on charges",
      actor: "dba-team",
    },
  ],
  signatureLog: "Seq Scan on charges",
  effects(ctx) {
    if (ctx.state.versions.database !== "schema-143") return;
    ctx.metrics.database.db_query_p95_ms += 2100;
    ctx.metrics.database.cpu_pct += 30;
    for (let i = 0; i < 2; i++) {
      ctx.log(
        "database",
        "WARN",
        "slow query 2.3s: SELECT * FROM charges WHERE merchant_id = $1 -- Seq Scan on charges (rows=4.2M)",
      );
    }
  },
};
