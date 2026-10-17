import type { Claim, Evidence } from "../evidence/schema.js";
import type { Alert, RootCauseKind, Service } from "../sim/types.js";
import { certificateOf, externalDependencyOf, mechanismsOf, replicationSlotOf } from "./catalog.js";
import type { Candidate } from "./schema.js";

type ChangeClaim = Extract<Claim, { kind: "change" }>;

/**
 * The deterministic rule catalog: every change record is a candidate, and
 * so is every condition the evidence shows signs of (a filling disk, a
 * leaking heap, an expired certificate, a failing third party). Candidates
 * are cheap; scoring decides which ones hold up.
 */
export function ruleCandidates(alert: Alert, evidence: readonly Evidence[]): Candidate[] {
  const changes: Candidate[] = [];
  const conditions = new Map<string, Candidate>();

  const addCondition = (kind: RootCauseKind, service: Service, start: number, ref: string | undefined) => {
    // External dependencies are told apart by name; other conditions by service.
    const key = kind === "external_dependency" ? `${kind}|${service}|${ref}` : `${kind}|${service}`;
    const existing = conditions.get(key);
    if (!existing) {
      conditions.set(key, { kind, service, start, title: "", origin: "rule", ...(ref !== undefined && { ref }) });
      return;
    }
    existing.start = Math.min(existing.start, start);
    if (existing.ref === undefined && ref !== undefined) existing.ref = ref;
  };

  for (const e of evidence) {
    const c = e.claim;
    switch (c.kind) {
      case "change":
        changes.push({
          kind: changeKind(c),
          service: c.subject.service ?? alert.service,
          ref: c.subject.ref,
          start: c.value.at,
          title: `${c.subject.type} ${c.subject.ref}: ${c.value.description}`,
          origin: "rule",
        });
        break;
      case "metric_anomaly":
        if (c.value.direction !== "up") break;
        if (c.subject.metric === "mem_pct") addCondition("memory_leak", c.subject.service, c.value.onset, undefined);
        if (c.subject.metric === "disk_pct") addCondition("disk_full", c.subject.service, c.value.onset, undefined);
        break;
      case "log_pattern": {
        const text = `${c.subject.template} ${c.value.sample}`;
        const at = c.value.firstSeen;
        for (const mechanism of mechanismsOf(text)) {
          if (mechanism === "cert") addCondition("cert_expiry", c.subject.service, at, certificateOf(c.value.sample));
          if (mechanism === "memory") addCondition("memory_leak", c.subject.service, at, undefined);
          if (mechanism === "disk") addCondition("disk_full", c.subject.service, at, replicationSlotOf(c.value.sample));
          if (mechanism === "external") addCondition("external_dependency", c.subject.service, at, externalDependencyOf(text));
        }
        break;
      }
      default:
        break;
    }
  }

  for (const candidate of conditions.values()) {
    // A leak is usually shipped: point at the last release before memory started climbing.
    if (candidate.kind === "memory_leak") {
      const release = latestDeployBefore(evidence, candidate.service, candidate.start);
      if (release) candidate.ref = release;
    }
    candidate.title = conditionTitle(candidate);
  }
  return [...changes, ...conditions.values()];
}

export function hypothesisId(c: Pick<Candidate, "kind" | "service" | "ref">): string {
  return `${c.kind}:${c.service}:${c.ref ?? "-"}`;
}

function changeKind(c: ChangeClaim): RootCauseKind {
  if (c.subject.type === "flag") return "flag_change";
  if (c.subject.type === "config") return "config_change";
  if (c.value.changeType === "migration") return "schema_migration";
  if (c.value.changeType === "config") return "config_change";
  return "bad_deploy";
}

function latestDeployBefore(evidence: readonly Evidence[], service: Service, t: number): string | undefined {
  let best: { ref: string; at: number } | undefined;
  for (const e of evidence) {
    const c = e.claim;
    if (c.kind !== "change" || c.subject.type !== "deploy" || c.subject.service !== service || c.value.at > t) continue;
    if (!best || c.value.at > best.at) best = { ref: c.subject.ref, at: c.value.at };
  }
  return best?.ref;
}

function conditionTitle(c: Candidate): string {
  switch (c.kind) {
    case "cert_expiry":
      return `${c.service} is using an expired certificate${c.ref ? ` (${c.ref})` : ""}`;
    case "memory_leak":
      return `memory leak in ${c.service}${c.ref ? `, introduced by ${c.ref}` : ""}`;
    case "disk_full":
      return `${c.service} disk is full${c.ref ? ` (replication slot ${c.ref} retaining WAL)` : ""}`;
    case "external_dependency":
      return `external dependency ${c.ref ?? "unknown"} is failing ${c.service}'s calls`;
    default:
      return `${c.kind} in ${c.service}`;
  }
}
