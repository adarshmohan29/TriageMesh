import type { Capability } from "../registry/tool.js";
import { MINUTE_MS } from "../sim/baseline.js";
import { SERVICES, type Alert, type MetricName, type Service } from "../sim/types.js";

/** Long enough to catch a change whose effect builds slowly (memory-leak: 72 min). */
export const CHANGE_LOOKBACK_MINUTES = 180;
export const TELEMETRY_LOOKBACK_MINUTES = 90;

/** A step before routing: what to learn, not yet which tool. */
export interface Need {
  id: string;
  capability: Capability;
  input: Record<string, unknown>;
  purpose: string;
  /** Core needs are always kept, even when the LLM drafts the plan. */
  core: boolean;
}

/** Health signals worth checking per service, beyond the alert's own metric. */
const KEY_METRICS: Record<Service, MetricName[]> = {
  api: ["error_rate", "latency_p95_ms", "mem_pct", "restarts"],
  payments: ["error_rate", "latency_p95_ms", "db_pool_in_use", "cpu_pct"],
  database: ["cpu_pct", "db_query_p95_ms", "disk_pct", "db_connections"],
};

/**
 * The alerting service, everything it calls, and its direct caller.
 * SERVICES is ordered by request flow (api -> payments -> database).
 * Errors and latency travel *up* the chain (a slow database makes payments
 * slow), so anything downstream is a suspect. Load travels *down* (a caller
 * retrying aggressively overloads its callee), so the direct caller is too.
 */
export function suspectServices(alert: Pick<Alert, "service">): Service[] {
  const index = SERVICES.indexOf(alert.service);
  return SERVICES.slice(Math.max(0, index - 1));
}

/**
 * The deterministic investigation: every change in the lookback, the alert
 * metric, key metrics and logs for each suspect service. Pure, so the mock
 * planner and the fallback share it.
 */
export function templateNeeds(alert: Alert, services: readonly Service[] = suspectServices(alert)): Need[] {
  const t = alert.firedAt;
  const changes = { from: t - CHANGE_LOOKBACK_MINUTES * MINUTE_MS, to: t };
  const telemetry = { from: t - TELEMETRY_LOOKBACK_MINUTES * MINUTE_MS, to: t };

  const needs: Need[] = [
    { id: "status", capability: "status.read", input: {}, purpose: "running versions, restarts and db primary", core: true },
    { id: "deploys", capability: "deploys.read", input: changes, purpose: "deploys before the alert", core: true },
    { id: "flags", capability: "flags.read", input: changes, purpose: "feature flag changes before the alert", core: true },
    { id: "config", capability: "config.read", input: changes, purpose: "config changes before the alert", core: true },
    {
      id: metricId(alert.service, alert.metric),
      capability: "metrics.read",
      input: { service: alert.service, metric: alert.metric, ...telemetry },
      purpose: `the alerting signal: ${alert.title}`,
      core: true,
    },
  ];

  for (const service of services) {
    for (const metric of KEY_METRICS[service]) {
      const id = metricId(service, metric);
      if (needs.some((n) => n.id === id)) continue;
      needs.push({
        id,
        capability: "metrics.read",
        input: { service, metric, source: "prometheus", ...telemetry },
        purpose: `${service} ${metric} around the alert`,
        core: false,
      });
    }
    needs.push({
      id: `logs-${service}`,
      capability: "logs.read",
      // No level filter: an INFO line (e.g. a cert renewal) can be the clue.
      input: { service, limit: 1000, ...telemetry },
      purpose: `${service} logs around the alert`,
      core: false,
    });
  }
  return needs;
}

function metricId(service: Service, metric: MetricName): string {
  return `metric-${service}-${metric}`;
}
