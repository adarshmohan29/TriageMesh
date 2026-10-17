import type { Evidence } from "../evidence/schema.js";
import { MINUTE_MS } from "../sim/baseline.js";
import type { Service } from "../sim/types.js";
import { blamedService, CHANGE_KINDS, callersOf, COMPATIBLE, dependenciesOf, externalDependencyOf, mechanismsOf, reach } from "./catalog.js";
import { hypothesisId } from "./candidates.js";
import { TOLERANCE_MS, type Symptom } from "./conflicts.js";
import type { Candidate, EvidenceLink, Hypothesis } from "./schema.js";

/**
 * Relation strengths: how much one piece of evidence says about a cause,
 * before trust, timing and agreement are applied. A change landing after
 * the symptom is the strongest signal there is (it rules the change out).
 */
const STRENGTH = {
  changeBeforeOnset: 1,
  changeAfterOnset: 1.5,
  mechanism: 1.5,
  symptom: 1,
  predatesCause: 0.5,
  healthyRoot: 0.3,
  blamesElsewhere: 0.8,
  blamesHere: 0.5,
  genericLog: 0.3,
} as const;

/** Changes this close to an effect get full credit; credit halves every HALF_LIFE after. */
const FULL_CREDIT_MIN = 10;
const HALF_LIFE_MIN = 20;
const MIN_PROXIMITY = 0.05;

/** Each extra independent source agreeing on an observation adds 25%, up to +50%. */
const AGREEMENT_STEP = 0.25;
const MAX_AGREEMENT = 1.5;

interface Relation {
  direction: "for" | "against";
  strength: number;
  /** 0..1, how close in time cause and effect are (changes only). */
  timing: number;
  reason: string;
}

export interface ScoreContext {
  symptom: Symptom;
  /** Evidence to leave out (overruled in a conflict, or never usable as support). */
  excluded: ReadonlySet<string>;
}

/**
 * Score every candidate against every piece of evidence. Pure and
 * deterministic: the LLM can suggest candidates but never touches scores.
 *
 *   score = Σ support − Σ contradiction
 *   weight = reliability × strength × timing × agreement
 *
 * `reliability` already carries the source's prior trust and any skew
 * penalty (see evidence/schema.ts). Evidence describing the same thing
 * (same metric, same log template, same change) is grouped: one source
 * repeating itself counts once, and other independent sources saying the
 * same add the agreement bonus.
 */
export function scoreCandidates(candidates: readonly Candidate[], evidence: readonly Evidence[], ctx: ScoreContext): Hypothesis[] {
  const usable = evidence.filter((e) => !ctx.excluded.has(e.id));
  const anomalous = new Set<Service>();
  for (const e of usable) {
    if (e.claim.kind === "metric_anomaly" || (e.claim.kind === "metric_events" && e.claim.value.count > 0)) {
      anomalous.add(e.claim.subject.service);
    }
  }

  const seen = new Set<string>();
  const scored: Omit<Hypothesis, "rank" | "confidence">[] = [];
  for (const candidate of candidates) {
    const id = hypothesisId(candidate);
    if (seen.has(id)) continue;
    seen.add(id);

    const related = usable.flatMap((e) => {
      const r = relate(candidate, e, ctx.symptom, anomalous);
      return r ? [{ e, ...r }] : [];
    });
    const support = links(related.filter((r) => r.direction === "for"));
    const contra = links(related.filter((r) => r.direction === "against"));
    const score = round(sum(support) - sum(contra));
    scored.push({ ...candidate, id, score, for: support, against: contra });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const mass = scored.reduce((m, h) => m + Math.max(0, h.score), 0);
  return scored.map((h, i) => ({ ...h, rank: i + 1, confidence: mass > 0 ? round(Math.max(0, h.score) / mass) : 0 }));
}

/** How one piece of evidence bears on one candidate, if at all. */
function relate(h: Candidate, e: Evidence, symptom: Symptom, anomalous: ReadonlySet<Service>): Relation | undefined {
  const isChange = CHANGE_KINDS.has(h.kind);
  // Conditions (a full disk, an expired cert) bite when they bite; only a
  // change's credit fades with the time between it and the effect.
  const timing = (t: number) => (isChange ? proximity(t - h.start) : 1);
  const before = (t: number) => t < h.start - TOLERANCE_MS;
  const c = e.claim;

  switch (c.kind) {
    case "change": {
      if (!isChange || c.subject.ref !== h.ref) return undefined;
      const gap = minutes(symptom.onset - c.value.at);
      return c.value.at > symptom.onset + TOLERANCE_MS
        ? against(STRENGTH.changeAfterOnset, `landed ${-gap}m after the symptom began, so it cannot be the cause`)
        : support(STRENGTH.changeBeforeOnset, proximity(symptom.onset - c.value.at), `landed ${gap}m before the symptom began`);
    }

    case "metric_anomaly": {
      const r = reach(h.service, c.subject.service);
      if (r === 0) return undefined;
      const what = `${c.subject.service}.${c.subject.metric} ${c.value.direction}`;
      if (before(c.value.onset)) {
        return against(STRENGTH.predatesCause * r, `${what} began ${minutes(h.start - c.value.onset)}m before this cause`);
      }
      if (c.subject.service === h.service && showsMechanism(h, c.subject.metric)) {
        return support(STRENGTH.mechanism, 1, `${what} is this cause's own signature`);
      }
      return support(STRENGTH.symptom * r, timing(c.value.onset), `${what} from ${minutes(c.value.onset - h.start)}m after it`);
    }

    case "metric_events":
      if (h.kind !== "memory_leak" || c.subject.service !== h.service || c.value.count === 0) return undefined;
      return support(STRENGTH.symptom, 1, `${c.value.count} restart(s) of ${h.service}`);

    case "metric_normal":
      // A cause in a service that shows no trouble at all is less likely.
      if (c.subject.service !== h.service || anomalous.has(h.service)) return undefined;
      return against(STRENGTH.healthyRoot, `${c.subject.service}.${c.subject.metric} is normal and ${h.service} shows no anomalies`);

    case "log_pattern": {
      const text = `${c.subject.template} ${c.value.sample}`;
      const where = c.subject.service;
      const blamed = blamedService(text);
      if (blamed) {
        // "api: upstream payments failed" points away from api and toward payments or deeper.
        if (h.service === where || callersOf(where).includes(h.service)) {
          return against(STRENGTH.blamesElsewhere, `${where} logs blame its dependency ${blamed}`);
        }
        if ((h.service === blamed || dependenciesOf(blamed).includes(h.service)) && !before(c.value.firstSeen)) {
          return support(STRENGTH.blamesHere, timing(c.value.firstSeen), `${where} logs blame ${blamed}`);
        }
        return undefined;
      }

      const r = reach(h.service, where);
      if (r === 0) return undefined;
      const mechanisms = mechanismsOf(text);
      if (mechanisms.length > 0) {
        // A log explained by a different mechanism says nothing about this cause.
        if (!mechanisms.some((m) => COMPATIBLE[h.kind].includes(m))) return undefined;
        if (h.kind === "external_dependency" && externalDependencyOf(text) !== h.ref) return undefined;
        if (before(c.value.firstSeen)) {
          return isChange ? against(STRENGTH.predatesCause * r, `"${c.subject.template}" was already logged before this change`) : undefined;
        }
        return support(STRENGTH.mechanism * r, timing(c.value.firstSeen), `${where} ${c.value.level} "${c.subject.template}" fits ${h.kind}`);
      }
      if (c.value.level === "INFO" || before(c.value.firstSeen)) return undefined;
      return support(STRENGTH.genericLog * r, timing(c.value.firstSeen), `${where} ${c.value.level} logs after it`);
    }

    // Injected instructions are reported, never weighed; skew and state are
    // used upstream (timestamp correction, conflicts) rather than here.
    case "suspicious_instruction":
    case "clock_skew":
    case "service_state":
      return undefined;
  }
}

function showsMechanism(h: Candidate, metric: string): boolean {
  return (h.kind === "memory_leak" && metric === "mem_pct") || (h.kind === "disk_full" && metric === "disk_pct");
}

/**
 * Group related evidence by what it observed, then weight each group once:
 * the strongest piece per source, the best source's weight, times a bonus
 * for each other independent source that agrees. The other members are
 * listed with weight 0 so the report still shows them.
 */
function links(related: readonly ({ e: Evidence } & Relation)[]): EvidenceLink[] {
  const groups = new Map<string, ({ e: Evidence; weight: number } & Relation)[]>();
  for (const r of related) {
    const key = observationKey(r.e);
    groups.set(key, [...(groups.get(key) ?? []), { ...r, weight: r.e.reliability * r.strength * r.timing }]);
  }

  const out: EvidenceLink[] = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => b.weight - a.weight || a.e.id.localeCompare(b.e.id));
    const best = ordered[0];
    if (!best) continue;
    const others = [...new Set(ordered.map((m) => m.e.source))].filter((s) => s !== best.e.source && s !== "derived");
    const bonus = Math.min(MAX_AGREEMENT, 1 + AGREEMENT_STEP * others.length);
    const corroboration = others.length > 0 ? `; corroborated by ${others.join(", ")}` : "";
    out.push({ evidenceId: best.e.id, weight: round(best.weight * bonus), reason: `${best.reason} [${best.e.source}${corroboration}]` });
    for (const m of ordered.slice(1)) {
      const why = m.e.source === best.e.source ? "same observation, same source" : "agreeing source";
      out.push({ evidenceId: m.e.id, weight: 0, reason: `counted with ${best.e.id} (${why})` });
    }
  }
  return out;
}

/** What a piece of evidence is about, independent of who reported it. */
function observationKey(e: Evidence): string {
  const c = e.claim;
  switch (c.kind) {
    case "metric_anomaly":
    case "metric_normal":
    case "metric_events":
      return `metric:${c.subject.service}.${c.subject.metric}`;
    case "log_pattern":
      return `log:${c.subject.service}|${c.subject.template}`;
    case "change":
      return `change:${c.subject.type}:${c.subject.ref}`;
    default:
      return `id:${e.id}`;
  }
}

/** 1 within FULL_CREDIT_MIN of the cause, halving every HALF_LIFE_MIN after. */
export function proximity(gapMs: number): number {
  const gap = Math.max(0, gapMs / MINUTE_MS);
  if (gap <= FULL_CREDIT_MIN) return 1;
  return Math.max(MIN_PROXIMITY, 0.5 ** ((gap - FULL_CREDIT_MIN) / HALF_LIFE_MIN));
}

function support(strength: number, timing: number, reason: string): Relation {
  return { direction: "for", strength, timing, reason };
}

function against(strength: number, reason: string): Relation {
  return { direction: "against", strength, timing: 1, reason };
}

function minutes(ms: number): number {
  return Math.round(ms / MINUTE_MS);
}

function sum(links: readonly EvidenceLink[]): number {
  return links.reduce((s, l) => s + l.weight, 0);
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
