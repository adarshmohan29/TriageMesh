import type { IncidentScript } from "../incident.js";

const FLAG = "payments.aggressive_retries";

export const flagRetryStorm: IncidentScript = {
  id: "flag-retry-storm",
  title: "Aggressive-retries flag turns payments into a database DDoS",
  description:
    "Enabling a retry flag makes payments hammer the database with retries, saturating its CPU " +
    "and connections. An api deploy 25 minutes earlier is a red herring.",
  onsetMinute: 80,
  alert: {
    title: "Database CPU above 85%",
    service: "database",
    metric: "cpu_pct",
    comparator: ">",
    threshold: 85,
    minute: 84,
  },
  rootCause: {
    kind: "flag_change",
    service: "payments",
    ref: FLAG,
    summary: "payments.aggressive_retries amplifies every failed db call into up to 10 retries",
    remediations: [{ tool: "flags.set", args: { flag: FLAG, enabled: false } }],
  },
  timeline: [
    {
      minute: 55,
      kind: "deploy",
      id: "dep-api-5.1.1",
      service: "api",
      version: "5.1.1",
      previousVersion: "5.1.0",
      changeType: "code",
      description: "Update checkout copy",
      actor: "ci-bot",
    },
    {
      minute: 80,
      kind: "flag",
      id: "flag-aggressive-retries-on",
      flag: FLAG,
      enabled: true,
      previous: false,
      actor: "payments-team",
    },
  ],
  signatureLog: "retrying (attempt",
  effects(ctx) {
    if (!ctx.state.flags[FLAG]) return;
    const { database, payments } = ctx.metrics;
    database.cpu_pct += 55;
    database.db_connections *= 3.5;
    database.rps *= 3;
    database.db_query_p95_ms += 350;
    payments.cpu_pct += 25;
    payments.db_pool_in_use = 48;
    for (let i = 0; i < 3; i++) {
      ctx.log("payments", "WARN", "db call failed, retrying (attempt 7/10, backoff 5ms)");
    }
    ctx.log("database", "WARN", "too many connections for role payments (210/200)");
  },
};
