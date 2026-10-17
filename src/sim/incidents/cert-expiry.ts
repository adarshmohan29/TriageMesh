import type { IncidentScript } from "../incident.js";

const RENEWED_MINUTE = 30;
const EXPIRY_MINUTE = 82; // 13:22 UTC

export const certExpiry: IncidentScript = {
  id: "cert-expiry",
  title: "API client certificate for payments expires",
  description:
    "cert-manager renewed the api's mTLS client certificate on disk, but the api only loads " +
    "certificates at startup. When the old one expires every api->payments call fails. " +
    "Payments looks healthy (its traffic just drops).",
  onsetMinute: EXPIRY_MINUTE,
  alert: {
    title: "API error rate above 5%",
    service: "api",
    metric: "error_rate",
    comparator: ">",
    threshold: 0.05,
    minute: 84,
  },
  rootCause: {
    kind: "cert_expiry",
    service: "api",
    ref: "api-client",
    summary: "api is still using the expired api-client certificate; a restart loads the renewed one",
    remediations: [{ tool: "service.restart", args: { service: "api" } }],
  },
  timeline: [
    {
      minute: 79,
      kind: "flag",
      id: "flag-banner-on",
      flag: "api.new_checkout_banner",
      enabled: true,
      previous: false,
      actor: "growth-team",
    },
  ],
  signatureLog: "certificate has expired",
  effects(ctx) {
    if (ctx.minute === RENEWED_MINUTE) {
      ctx.log(
        "api",
        "INFO",
        "cert-manager: wrote renewed certificate api-client to /etc/tls/api-client.pem " +
          "(notAfter=2026-06-12T13:22:00Z); process reload required",
      );
    }
    if (ctx.minute === EXPIRY_MINUTE - 10) {
      ctx.log("api", "WARN", "loaded certificate CN=api-client expires in 10m");
    }

    // A restart any time after the renewal picks up the new certificate.
    const reloaded = (ctx.state.lastRestart.api ?? -Infinity) >= ctx.atMinute(RENEWED_MINUTE);
    if (ctx.minute < EXPIRY_MINUTE || reloaded) return;

    ctx.metrics.api.error_rate += 0.55;
    ctx.metrics.payments.rps *= 0.4;
    ctx.metrics.payments.cpu_pct -= 10;
    for (let i = 0; i < 3; i++) {
      ctx.log(
        "api",
        "ERROR",
        "TLS handshake with payments failed: certificate has expired (CN=api-client, notAfter=2026-03-14T13:22:00Z)",
      );
    }
  },
};
