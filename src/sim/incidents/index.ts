import type { IncidentScript } from "../incident.js";
import { badDeploy } from "./bad-deploy.js";
import { certExpiry } from "./cert-expiry.js";
import { diskFullInjection } from "./disk-full-injection.js";
import { flagRetryStorm } from "./flag-retry-storm.js";
import { memoryLeak } from "./memory-leak.js";
import { missingIndex } from "./missing-index.js";
import { poolExhaustion } from "./pool-exhaustion.js";
import { upstreamGateway } from "./upstream-gateway.js";

export const INCIDENTS: readonly IncidentScript[] = [
  badDeploy,
  flagRetryStorm,
  poolExhaustion,
  missingIndex,
  upstreamGateway,
  certExpiry,
  memoryLeak,
  diskFullInjection,
];

export const INCIDENT_IDS = INCIDENTS.map((i) => i.id);

export function getIncident(id: string): IncidentScript | undefined {
  return INCIDENTS.find((i) => i.id === id);
}
