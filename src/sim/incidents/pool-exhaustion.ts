import type { IncidentScript } from "../incident.js";

export const poolExhaustion: IncidentScript = {
  id: "pool-exhaustion",
  title: "Config change shrinks the payments DB pool from 50 to 5",
  description:
    "A cost-saving config deploy cuts the payments connection pool. Requests queue for a " +
    "connection and time out, while the database itself looks idle.",
  onsetMinute: 78,
  alert: {
    title: "Payments p95 latency above 1s",
    service: "payments",
    metric: "latency_p95_ms",
    comparator: ">",
    threshold: 1000,
    minute: 82,
  },
  rootCause: {
    kind: "config_change",
    service: "payments",
    ref: "dep-payments-pool-cfg",
    summary: "payments.db_pool_max was lowered to 5, starving requests of connections",
    remediations: [
      { tool: "deploy.rollback", args: { service: "payments" } },
      { tool: "db.pool.resize", args: { service: "payments", size: 50 } },
    ],
  },
  timeline: [
    {
      minute: 78,
      kind: "deploy",
      id: "dep-payments-pool-cfg",
      service: "payments",
      version: "2.3.0-cfg.7",
      previousVersion: "2.3.0",
      changeType: "config",
      description: "Tune connection pool for cost savings",
      config: { "payments.db_pool_max": 5 },
      previousConfig: { "payments.db_pool_max": 50 },
      actor: "platform-team",
    },
  ],
  signatureLog: "timeout acquiring connection",
  effects(ctx) {
    const max = Number(ctx.state.config["payments.db_pool_max"]);
    if (!(max < 20)) return;
    const { payments, database } = ctx.metrics;
    payments.db_pool_in_use = max;
    payments.latency_p95_ms += 1800;
    payments.latency_p50_ms += 600;
    payments.error_rate += 0.07;
    // The tell: the database is *less* busy, not more.
    database.db_connections = 15;
    database.rps *= 0.4;
    for (let i = 0; i < 3; i++) {
      ctx.log(
        "payments",
        "ERROR",
        `timeout acquiring connection from pool after 2000ms (pool max=${max}, in use=${max})`,
      );
    }
  },
};
