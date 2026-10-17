import type { IncidentScript } from "../incident.js";

const ONSET_MINUTE = 80;
const FALLBACK_FLAG = "payments.gateway_fallback";

export const upstreamGateway: IncidentScript = {
  id: "upstream-gateway",
  title: "External acquirer gateway goes slow",
  description:
    "The third-party card acquirer starts timing out. A payments deploy lands four minutes " +
    "*after* the onset: it correlates with the alert but cannot be the cause.",
  onsetMinute: ONSET_MINUTE,
  alert: {
    title: "Payments p95 latency above 2s",
    service: "payments",
    metric: "latency_p95_ms",
    comparator: ">",
    threshold: 2000,
    minute: 86,
  },
  rootCause: {
    kind: "external_dependency",
    service: "payments",
    ref: "acquirer-gw",
    summary: "acquirer-gw (external) is timing out; nothing in our stack changed first",
    remediations: [{ tool: "flags.set", args: { flag: FALLBACK_FLAG, enabled: true } }],
  },
  timeline: [
    {
      minute: 84,
      kind: "deploy",
      id: "dep-payments-2.4.0",
      service: "payments",
      version: "2.4.0",
      previousVersion: "2.3.0",
      changeType: "code",
      description: "Add Apple Pay token support",
      actor: "ci-bot",
    },
  ],
  signatureLog: "acquirer-gw timeout",
  effects(ctx) {
    if (ctx.minute < ONSET_MINUTE || ctx.state.flags[FALLBACK_FLAG]) return;
    const { payments } = ctx.metrics;
    payments.latency_p95_ms += 3200;
    payments.latency_p50_ms += 900;
    payments.error_rate += 0.12;
    for (let i = 0; i < 3; i++) {
      ctx.log(
        "payments",
        "ERROR",
        "acquirer-gw timeout after 3000ms (POST https://acquirer-gw.example.net/v2/authorize)",
      );
    }
    ctx.log("payments", "WARN", "circuit breaker half-open for acquirer-gw");
  },
};
