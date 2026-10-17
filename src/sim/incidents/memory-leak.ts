import type { IncidentScript } from "../incident.js";

const DEPLOY_MINUTE = 14;
/** Minutes from a fresh process to OOM kill. */
const LEAK_PERIOD = 72;

export const memoryLeak: IncidentScript = {
  id: "memory-leak",
  title: "Unbounded response cache in api 5.2.0 leaks memory until OOM",
  description:
    "api 5.2.0 adds an in-process cache with no eviction. Memory climbs steadily for over an " +
    "hour, then the process is OOM-killed and restarts. The cause is 72 minutes older than " +
    "the first symptom. Restarting only resets the clock; rolling back fixes it.",
  onsetMinute: DEPLOY_MINUTE + LEAK_PERIOD,
  alert: {
    title: "API error rate above 5%",
    service: "api",
    metric: "error_rate",
    comparator: ">",
    threshold: 0.05,
    minute: DEPLOY_MINUTE + LEAK_PERIOD + 1,
  },
  rootCause: {
    kind: "memory_leak",
    service: "api",
    ref: "dep-api-5.2.0",
    summary: "api 5.2.0's response cache never evicts, so memory grows until OOMKilled",
    remediations: [{ tool: "deploy.rollback", args: { service: "api" } }],
  },
  timeline: [
    {
      minute: DEPLOY_MINUTE,
      kind: "deploy",
      id: "dep-api-5.2.0",
      service: "api",
      version: "5.2.0",
      previousVersion: "5.1.0",
      changeType: "code",
      description: "Add in-process response cache for catalog lookups",
      actor: "ci-bot",
    },
  ],
  signatureLog: "OOMKilled",
  effects(ctx) {
    if (ctx.state.versions.api !== "5.2.0") return;
    const deployedAt = ctx.deployedAt("api");
    if (deployedAt === undefined) return;

    // Memory starts from zero on deploy and on every manual restart.
    const freshSince = Math.max(deployedAt, ctx.state.lastRestart.api ?? -Infinity);
    const age = Math.floor(ctx.minutesSince(freshSince));
    if (age <= 0) return;
    const phase = age % LEAK_PERIOD;

    const { api } = ctx.metrics;
    api.mem_pct = 45 + (50 * phase) / (LEAK_PERIOD - 1);
    // GC pressure makes latency worse as the heap fills.
    api.latency_p95_ms += Math.max(0, api.mem_pct - 80) * 40;
    if (api.mem_pct > 88) ctx.log("api", "WARN", `heap usage ${Math.round(api.mem_pct)}% of limit, GC pause 450ms`);

    if (phase === 0) {
      api.restarts = 1;
      api.error_rate += 0.35;
      ctx.log("api", "ERROR", "container api-7f9c killed: OOMKilled (memory limit 2Gi)");
      ctx.log("api", "WARN", "api restarted; response cache cold");
    } else if (phase === 1 && age > LEAK_PERIOD) {
      // The minute after an OOM (not the minute after the deploy).
      api.error_rate += 0.15;
    }
  },
};
