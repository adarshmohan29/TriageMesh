import type { z } from "zod";
import { createIdGenerator } from "../core/ids.js";
import type { ExecutionResult, StepResult } from "../executor/executor.js";
import type { LogLine, MetricName, MetricPoint, Service, Source } from "../sim/types.js";
import {
  ConfigHistoryOutputSchema,
  DeploysListOutputSchema,
  FlagsListOutputSchema,
  LogsSearchOutputSchema,
  MetricsQueryOutputSchema,
  ServiceStatusOutputSchema,
} from "../tools/read.js";
import { detectInjection, groupLogs } from "./logs.js";
import { SKEWED_SOURCE_PENALTY, SOURCE_RELIABILITY, type Claim, type Evidence, type EvidenceSource } from "./schema.js";
import { analyseSeries, median } from "./series.js";
import { estimateSkewMs } from "./skew.js";

export interface ExtractionResult {
  evidence: Evidence[];
  /** Steps that produced nothing usable, and why. */
  notes: string[];
}

type Draft = Omit<Evidence, "id">;

interface Series {
  service: Service;
  metric: MetricName;
  source: Source;
  stepId: string;
  points: MetricPoint[];
}

const REFERENCE_SOURCE: Source = "prometheus";

/**
 * Turn executed steps into typed Evidence. Pure and deterministic: the same
 * execution always yields the same evidence with the same ids.
 *
 * Tool output was schema-checked by GuardedInvoker; it is parsed again here
 * with the tool's exported schema so this module never trusts an `unknown`.
 */
export function extractEvidence(execution: ExecutionResult): ExtractionResult {
  const notes: string[] = [];
  const drafts: Draft[] = [];
  const series = new Map<string, Series>();
  const logLines = new Map<string, { line: LogLine; stepId: string }>();
  const seenEvents = new Set<string>();

  const parse = <S extends z.ZodType>(step: StepResult, schema: S): z.output<S> | undefined => {
    const parsed = schema.safeParse(step.output);
    if (!parsed.success) notes.push(`step "${step.stepId}": ${step.tool} output did not match its schema`);
    return parsed.success ? parsed.data : undefined;
  };

  for (const step of execution.steps) {
    if (step.status !== "ok") {
      notes.push(`step "${step.stepId}" ${step.status}: ${step.error?.message ?? "no output"}`);
      continue;
    }
    switch (step.tool) {
      case "metrics.query": {
        const out = parse(step, MetricsQueryOutputSchema);
        for (const p of out?.points ?? []) {
          const key = `${p.service}|${p.metric}|${p.source}`;
          const s = series.get(key) ?? { service: p.service, metric: p.metric, source: p.source, stepId: step.stepId, points: [] };
          // A later step re-fetching the same series adds nothing new.
          if (s.stepId === step.stepId) s.points.push(p);
          series.set(key, s);
        }
        break;
      }
      case "logs.search":
        for (const line of parse(step, LogsSearchOutputSchema)?.lines ?? []) {
          if (!logLines.has(line.id)) logLines.set(line.id, { line, stepId: step.stepId });
        }
        break;
      case "deploys.list":
        for (const d of parse(step, DeploysListOutputSchema)?.deploys ?? []) {
          if (seenEvents.has(d.id)) continue;
          seenEvents.add(d.id);
          drafts.push(change(step.stepId, "deploy-service", d.t, d, {
            kind: "change",
            subject: { type: "deploy", ref: d.id, service: d.service },
            value: {
              at: d.t,
              description: `${d.service} ${d.previousVersion} -> ${d.version}: ${d.description}`,
              actor: d.actor,
              changeType: d.changeType,
              from: d.previousVersion,
              to: d.version,
              ...(Object.keys(d.config).length > 0 && { config: d.config }),
            },
          }));
        }
        break;
      case "flags.list":
        for (const f of parse(step, FlagsListOutputSchema)?.changes ?? []) {
          if (seenEvents.has(f.id)) continue;
          seenEvents.add(f.id);
          drafts.push(change(step.stepId, "flag-service", f.t, f, {
            kind: "change",
            subject: { type: "flag", ref: f.flag, ...ownerService(f.flag) },
            value: { at: f.t, description: `${f.flag} ${f.previous} -> ${f.enabled}`, actor: f.actor, from: f.previous, to: f.enabled },
          }));
        }
        break;
      case "config.history":
        for (const c of parse(step, ConfigHistoryOutputSchema)?.changes ?? []) {
          // Config shipped in a deploy is already part of that deploy's claim.
          if (c.via === "deploy" || seenEvents.has(c.eventId)) continue;
          seenEvents.add(c.eventId);
          // Config history is served by the deploy service in this topology.
          drafts.push(change(step.stepId, "deploy-service", c.t, c, {
            kind: "change",
            subject: { type: "config", ref: c.key, ...ownerService(c.key) },
            value: { at: c.t, description: `${c.key}: ${String(c.previous ?? "unset")} -> ${String(c.value)}`, actor: c.actor, from: c.previous, to: c.value },
          }));
        }
        break;
      case "service.status": {
        const out = parse(step, ServiceStatusOutputSchema);
        for (const s of out?.services ?? []) {
          drafts.push({
            claim: { kind: "service_state", subject: { service: s.service }, value: s },
            timestamp: execution.finishedAt,
            source: "deploy-service",
            reliability: SOURCE_RELIABILITY["deploy-service"],
            stepId: step.stepId,
            rawData: { ...s, dbPrimary: out?.dbPrimary },
          });
        }
        break;
      }
      default:
        notes.push(`step "${step.stepId}": no extractor for ${step.tool}`);
    }
  }

  const skews = detectSkew([...series.values()], execution.finishedAt);
  for (const skew of skews) drafts.push(skew.evidence);
  const skewBy = new Map(skews.map((s) => [s.source, s.offsetMs]));

  for (const s of series.values()) drafts.push(...metricEvidence(s, skewBy.get(s.source) ?? 0));
  drafts.push(...logEvidence([...logLines.values()]));

  const ids = createIdGenerator();
  return { evidence: drafts.map((d) => ({ id: ids.next("ev"), ...d })), notes };
}

function change(stepId: string, source: EvidenceSource, t: number, raw: unknown, claim: Claim): Draft {
  return { claim, timestamp: t, source, reliability: SOURCE_RELIABILITY[source], stepId, rawData: raw };
}

/** "payments.db_pool_max" -> { service: "payments" }, when the prefix names a service. */
function ownerService(key: string): { service?: Service } {
  const prefix = key.split(".")[0];
  return prefix === "api" || prefix === "payments" || prefix === "database" ? { service: prefix } : {};
}

/**
 * For each non-reference source, estimate its clock offset from every
 * metric it shares with the reference, and take the median. Agreement
 * across metrics is what makes this a clock problem rather than one odd
 * series.
 */
function detectSkew(all: Series[], now: number): { source: Source; offsetMs: number; evidence: Draft }[] {
  const out: { source: Source; offsetMs: number; evidence: Draft }[] = [];
  const sources = [...new Set(all.map((s) => s.source))].filter((s) => s !== REFERENCE_SOURCE).sort();
  for (const source of sources) {
    const estimates: { metric: string; offset: number; stepId: string }[] = [];
    for (const s of all.filter((x) => x.source === source)) {
      const ref = all.find((x) => x.source === REFERENCE_SOURCE && x.service === s.service && x.metric === s.metric);
      if (!ref) continue;
      const offset = estimateSkewMs(ref.points, s.points);
      if (offset !== undefined) estimates.push({ metric: `${s.service}.${s.metric}`, offset, stepId: s.stepId });
    }
    const offsetMs = Math.round(median(estimates.map((e) => e.offset)));
    if (estimates.length === 0 || offsetMs === 0) continue;
    const basis = estimates.filter((e) => e.offset === offsetMs);
    out.push({
      source,
      offsetMs,
      evidence: {
        claim: { kind: "clock_skew", subject: { source, reference: REFERENCE_SOURCE }, value: { offsetMs, basis: basis.map((e) => e.metric) } },
        timestamp: now,
        source: "derived",
        // Stronger when more metrics agree on the same offset.
        reliability: Math.min(0.95, 0.5 + 0.15 * basis.length),
        stepId: basis[0]?.stepId ?? "",
        rawData: { estimates },
      },
    });
  }
  return out;
}

function metricEvidence(s: Series, skewMs: number): Draft[] {
  // Undo the source's clock error before judging when things happened.
  const points = s.points.map((p) => ({ t: p.t - skewMs, value: p.value }));
  const verdict = analyseSeries(s.metric, points);
  const reliability = Math.max(0.1, SOURCE_RELIABILITY[s.source] - (skewMs !== 0 ? SKEWED_SOURCE_PENALTY : 0));
  const subject = { service: s.service, metric: s.metric };
  const rawData = { source: s.source, points: points.length, last: points.slice(-5), ...(skewMs !== 0 && { correctedBySkewMs: skewMs }) };
  const base = { source: s.source as EvidenceSource, reliability, stepId: s.stepId, rawData };
  const lastT = points.at(-1)?.t ?? 0;

  switch (verdict.kind) {
    case "insufficient":
      return [];
    case "events":
      return verdict.count > 0
        ? [{ ...base, claim: { kind: "metric_events", subject, value: { count: verdict.count, times: verdict.times } }, timestamp: verdict.times[0] ?? lastT }]
        : [{ ...base, claim: { kind: "metric_normal", subject, value: { baseline: 0, latest: 0 } }, timestamp: lastT }];
    case "normal":
      return [{ ...base, claim: { kind: "metric_normal", subject, value: { baseline: verdict.baseline, latest: verdict.latest } }, timestamp: lastT }];
    case "anomaly": {
      const { kind: _kind, ...value } = verdict;
      return [{ ...base, claim: { kind: "metric_anomaly", subject, value }, timestamp: verdict.onset }];
    }
  }
}

function logEvidence(entries: { line: LogLine; stepId: string }[]): Draft[] {
  const drafts: Draft[] = [];
  const stepOf = new Map(entries.map((e) => [e.line.id, e.stepId]));
  const ordinary: LogLine[] = [];

  for (const { line, stepId } of entries) {
    const matched = detectInjection(line.message);
    if (!matched) {
      ordinary.push(line);
      continue;
    }
    drafts.push({
      claim: { kind: "suspicious_instruction", subject: { service: line.service, logId: line.id }, value: { text: line.message.slice(0, 500), matched } },
      timestamp: line.t,
      source: "loki",
      reliability: SOURCE_RELIABILITY.loki,
      stepId,
      rawData: line,
    });
  }

  for (const group of groupLogs(ordinary)) {
    const lines = [...group.lines].sort((a, b) => a.t - b.t);
    const first = lines[0];
    const last = lines.at(-1);
    if (!first || !last) continue;
    drafts.push({
      claim: {
        kind: "log_pattern",
        subject: { service: first.service, template: group.template },
        value: { level: group.level, count: lines.length, firstSeen: first.t, lastSeen: last.t, sample: first.message.slice(0, 300) },
      },
      timestamp: first.t,
      source: "loki",
      reliability: SOURCE_RELIABILITY.loki,
      stepId: stepOf.get(first.id) ?? "",
      rawData: { ids: lines.slice(0, 5).map((l) => l.id) },
    });
  }
  return drafts.sort((a, b) => a.timestamp - b.timestamp);
}
