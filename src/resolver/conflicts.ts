import { createIdGenerator } from "../core/ids.js";
import type { Evidence, EvidenceSource } from "../evidence/schema.js";
import { MINUTE_MS } from "../sim/baseline.js";
import type { Alert } from "../sim/types.js";
import { reach } from "./catalog.js";
import type { ConflictRecord, Resolution } from "./schema.js";

/** Telemetry is per minute, so "same minute" counts as simultaneous. */
export const TOLERANCE_MS = MINUTE_MS;

/** Below this trust difference neither side of a value conflict wins. */
const UNRESOLVED_MARGIN = 0.05;

/** Log groups this large count as "errors are happening" against a metric. */
const PRESENCE_MIN_LINES = 3;

export interface Symptom {
  /** When the alerting metric started to degrade (firedAt if no anomaly was found). */
  onset: number;
  /** Anomaly evidence for the alerting metric. */
  evidenceIds: string[];
}

export interface ConflictAnalysis {
  conflicts: ConflictRecord[];
  /** Evidence on the losing side of a value/presence conflict; scoring ignores it. */
  overruled: Set<string>;
  flaggedSources: Resolution["flaggedSources"];
}

/** The alert's own metric, as seen by the most trusted source. */
export function findSymptom(alert: Alert, evidence: readonly Evidence[]): Symptom {
  const own = evidence.filter(
    (e) => e.claim.kind === "metric_anomaly" && e.claim.subject.service === alert.service && e.claim.subject.metric === alert.metric,
  );
  const best = [...own].sort((a, b) => b.reliability - a.reliability || a.timestamp - b.timestamp)[0];
  return { onset: best?.timestamp ?? alert.firedAt, evidenceIds: own.map((e) => e.id) };
}

/**
 * Find disagreements and settle them in code:
 *  - clock skew (found by the extractor): the reference source's timeline wins;
 *  - two readings of one metric: the side with more independent trust wins,
 *    and the loser's evidence is overruled;
 *  - a change that landed after the symptom began: it can't be the cause.
 */
export function detectConflicts(alert: Alert, evidence: readonly Evidence[], symptom: Symptom): ConflictAnalysis {
  const ids = createIdGenerator();
  const conflicts: ConflictRecord[] = [];
  const overruled = new Set<string>();
  const flagged: Resolution["flaggedSources"] = [];
  const flag = (source: EvidenceSource, reason: string) => {
    if (!flagged.some((f) => f.source === source && f.reason === reason)) flagged.push({ source, reason });
  };

  // ---- Clock skew ----------------------------------------------------------
  for (const e of evidence) {
    if (e.claim.kind !== "clock_skew") continue;
    const { source, reference } = e.claim.subject;
    const { offsetMs, basis } = e.claim.value;
    const minutes = Math.round(Math.abs(offsetMs) / MINUTE_MS);
    const drift = `${minutes}m ${offsetMs > 0 ? "fast" : "slow"}`;
    flag(source, `clock runs ${drift} relative to ${reference}; timestamps corrected and reliability lowered`);
    const on = (s: EvidenceSource) => evidence.filter((x) => x.source === s && basis.includes(metricKey(x) ?? "")).map((x) => x.id);
    const [a, b] = [on(source), on(reference)];
    if (a.length === 0 || b.length === 0) continue;
    conflicts.push({
      id: ids.next("cf"),
      kind: "temporal",
      subject: `${source} clock`,
      a,
      b,
      resolution: "skew_corrected",
      winner: "b",
      rationale:
        `${source} reports ${basis.join(", ")} ${drift} relative to ${reference}. ` +
        `${reference} is the reference clock, so ${source}'s timestamps were shifted to match.`,
    });
  }

  // ---- Value / presence ------------------------------------------------------
  for (const [subject, readings] of readingsByMetric(evidence)) {
    const sides = [...groupBy(readings, (r) => r.verdict)]
      .map(([verdict, rs]) => ({ verdict, evidence: rs.map((r) => r.e), trust: independentTrust(rs.map((r) => r.e)) }))
      .sort((x, y) => y.trust - x.trust || x.verdict.localeCompare(y.verdict));
    const [top, second, ...rest] = sides;
    if (!top || !second) continue;

    const resolved = top.trust - second.trust >= UNRESOLVED_MARGIN;
    const describe = (s: typeof top) => `${[...new Set(s.evidence.map((e) => e.source))].join(" + ")} say "${s.verdict}" (trust ${s.trust.toFixed(2)})`;
    conflicts.push({
      id: ids.next("cf"),
      kind: [top, second].some((s) => s.evidence.some((e) => e.claim.kind === "log_pattern")) ? "presence" : "value",
      subject,
      a: top.evidence.map((e) => e.id),
      b: second.evidence.map((e) => e.id),
      resolution: resolved ? "trust_weighted" : "unresolved",
      winner: resolved ? "a" : "none",
      rationale: resolved
        ? `${describe(top)} outweighs ${describe(second)}.`
        : `${describe(top)} and ${describe(second)} are too close to call; neither is used.`,
    });
    // Unresolved: both sides are set aside rather than guessing.
    for (const side of resolved ? [second, ...rest] : sides) {
      for (const e of side.evidence) {
        overruled.add(e.id);
        if (resolved) flag(e.source, `overruled on ${subject}`);
      }
    }
  }

  // ---- Cause after effect ----------------------------------------------------
  for (const e of evidence) {
    const c = e.claim;
    if (c.kind !== "change" || symptom.evidenceIds.length === 0) continue;
    if (c.value.at <= symptom.onset + TOLERANCE_MS) continue;
    if (c.subject.service && reach(c.subject.service, alert.service) === 0) continue;
    const late = Math.round((c.value.at - symptom.onset) / MINUTE_MS);
    conflicts.push({
      id: ids.next("cf"),
      kind: "temporal",
      subject: `${c.subject.ref} vs ${alert.service}.${alert.metric}`,
      a: [e.id],
      b: symptom.evidenceIds,
      resolution: "cause_after_effect",
      winner: "b",
      rationale:
        `${c.subject.type} ${c.subject.ref} landed ${late}m after onset of ${alert.service}.${alert.metric}. ` +
        "It correlates with the alert but cannot have caused something that began before it.",
    });
  }

  return { conflicts, overruled, flaggedSources: flagged };
}

type Verdict = "up" | "down" | "normal";

/** Every reading of each "service.metric", from metrics and (for error rates) error logs. */
function readingsByMetric(evidence: readonly Evidence[]): Map<string, { verdict: Verdict; e: Evidence }[]> {
  const out = new Map<string, { verdict: Verdict; e: Evidence }[]>();
  const add = (key: string, verdict: Verdict, e: Evidence) => out.set(key, [...(out.get(key) ?? []), { verdict, e }]);
  for (const e of evidence) {
    const key = metricKey(e);
    if (e.claim.kind === "metric_anomaly" && key) add(key, e.claim.value.direction, e);
    if (e.claim.kind === "metric_normal" && key) add(key, "normal", e);
  }
  // Logs only join a metric someone measured: "errors are happening" vs "error rate is normal".
  for (const e of evidence) {
    const c = e.claim;
    if (c.kind !== "log_pattern" || c.value.level !== "ERROR" || c.value.count < PRESENCE_MIN_LINES) continue;
    const key = `${c.subject.service}.error_rate`;
    if (out.has(key)) add(key, "up", e);
  }
  return out;
}

function metricKey(e: Evidence): string | undefined {
  const c = e.claim;
  if (c.kind === "metric_anomaly" || c.kind === "metric_normal" || c.kind === "metric_events") {
    return `${c.subject.service}.${c.subject.metric}`;
  }
  return undefined;
}

/**
 * Trust of one side: each source counts once (its most reliable piece), so
 * one source repeating itself can't outvote two that agree.
 */
export function independentTrust(evidence: readonly Evidence[]): number {
  const best = new Map<EvidenceSource, number>();
  for (const e of evidence) best.set(e.source, Math.max(best.get(e.source) ?? 0, e.reliability));
  return [...best.values()].reduce((sum, r) => sum + r, 0);
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}
