import type { IncidentScript } from "../incident.js";

export const badDeploy: IncidentScript = {
  id: "bad-deploy",
  title: "Payments 2.3.1 throws on every multi-currency charge",
  description:
    "A payments release refactors the charge serializer and breaks currency handling. " +
    "An unrelated feature flag flipped earlier is a red herring.",
  onsetMinute: 82,
  alert: {
    title: "Payments error rate above 5%",
    service: "payments",
    metric: "error_rate",
    comparator: ">",
    threshold: 0.05,
    minute: 85,
  },
  rootCause: {
    kind: "bad_deploy",
    service: "payments",
    ref: "dep-payments-2.3.1",
    summary: "payments 2.3.1 introduced a null dereference in ChargeSerializer",
    remediations: [{ tool: "deploy.rollback", args: { service: "payments" } }],
  },
  timeline: [
    {
      minute: 40,
      kind: "flag",
      id: "flag-banner-on",
      flag: "api.new_checkout_banner",
      enabled: true,
      previous: false,
      actor: "growth-team",
    },
    {
      minute: 82,
      kind: "deploy",
      id: "dep-payments-2.3.1",
      service: "payments",
      version: "2.3.1",
      previousVersion: "2.3.0",
      changeType: "code",
      description: "Refactor charge serializer; add multi-currency rounding",
      actor: "ci-bot",
    },
  ],
  signatureLog: "ChargeSerializer",
  effects(ctx) {
    if (ctx.state.versions.payments !== "2.3.1") return;
    ctx.metrics.payments.error_rate += 0.18;
    ctx.metrics.payments.cpu_pct += 5;
    for (let i = 0; i < 3; i++) {
      ctx.log(
        "payments",
        "ERROR",
        "TypeError: Cannot read properties of undefined (reading 'currency') at ChargeSerializer.serialize (charge-serializer.ts:88)",
      );
    }
  },
};
