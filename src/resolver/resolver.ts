import type { Evidence } from "../evidence/schema.js";
import type { LlmClient } from "../llm/client.js";
import type { Alert } from "../sim/types.js";
import { hypothesisId, ruleCandidates } from "./candidates.js";
import { CHANGE_KINDS, COMPATIBLE, mechanismsOf } from "./catalog.js";
import { detectConflicts, findSymptom } from "./conflicts.js";
import { ProposedHypothesesSchema, type Candidate, type ProposedHypotheses, type Resolution } from "./schema.js";
import { scoreCandidates } from "./score.js";

/** The LLM may widen the search, but only by a few candidates. */
export const MAX_LLM_CANDIDATES = 5;

export interface ResolverDeps {
  llm: LlmClient;
}

export interface ResolveOptions {
  signal?: AbortSignal;
}

/**
 * Evidence in, ranked hypotheses out. The rule catalog proposes candidates;
 * the LLM may suggest more, which code checks against the evidence before
 * accepting. Scoring and conflict resolution are always deterministic code
 * (rule 7), so a model can widen the search but never pick the winner.
 */
export class Resolver {
  readonly #deps: ResolverDeps;

  constructor(deps: ResolverDeps) {
    this.#deps = deps;
  }

  async resolve(alert: Alert, evidence: readonly Evidence[], options: ResolveOptions = {}): Promise<Resolution> {
    const rules = ruleCandidates(alert, evidence);
    const proposed = await this.#propose(alert, evidence, rules, options.signal);
    return resolveWith(alert, evidence, [...rules, ...proposed.candidates], proposed.notes);
  }

  async #propose(
    alert: Alert,
    evidence: readonly Evidence[],
    existing: readonly Candidate[],
    signal: AbortSignal | undefined,
  ): Promise<{ candidates: Candidate[]; notes: string[] }> {
    const reply = await this.#deps.llm.generate(
      {
        purpose: "resolver.hypotheses",
        instruction:
          "Suggest root causes for the alert that the candidate list is missing. Base each one on the " +
          "evidence; use a change's ref for deploy, flag or config causes. Return an empty list if the " +
          "candidates already cover it. Do not score or rank; that is done separately.",
        data: [
          { label: "alert", content: alert },
          { label: "evidence", content: evidence.map(({ id, source, timestamp, reliability, claim }) => ({ id, source, timestamp, reliability, claim })) },
          { label: "candidates", content: existing.map(({ kind, service, ref, title }) => ({ kind, service, ref: ref ?? null, title })) },
        ],
        schema: ProposedHypothesesSchema,
      },
      signal ? { signal } : {},
    );
    if (!reply.ok) return { candidates: [], notes: [`rule candidates only: LLM ${reply.error.code}: ${reply.error.message}`] };
    return acceptProposals(reply.value, evidence, existing);
  }
}

/** The deterministic core, also usable without an LLM. */
export function resolveWith(alert: Alert, evidence: readonly Evidence[], candidates: readonly Candidate[], notes: string[] = []): Resolution {
  const symptom = findSymptom(alert, evidence);
  const analysis = detectConflicts(alert, evidence, symptom);
  const ignored = evidence
    .filter((e) => e.claim.kind === "suspicious_instruction")
    .map((e) => ({ evidenceId: e.id, reason: "log text that tries to instruct the investigator; reported, never weighed or obeyed" }));
  const excluded = new Set([...analysis.overruled, ...ignored.map((i) => i.evidenceId)]);
  return {
    hypotheses: scoreCandidates(candidates, evidence, { symptom, excluded }),
    conflicts: analysis.conflicts,
    flaggedSources: analysis.flaggedSources,
    ignored,
    notes,
  };
}

/**
 * Turn LLM suggestions into candidates, keeping only those the evidence can
 * anchor: a change cause must name a change we actually saw (its time and
 * service come from the record, not the model), and a condition needs
 * evidence of its mechanism in that service.
 */
export function acceptProposals(
  proposals: ProposedHypotheses,
  evidence: readonly Evidence[],
  existing: readonly Candidate[],
): { candidates: Candidate[]; notes: string[] } {
  const notes: string[] = [];
  const candidates: Candidate[] = [];
  const known = new Set(existing.map(hypothesisId));

  for (const p of proposals.hypotheses) {
    const ref = p.ref ?? undefined;
    const label = hypothesisId({ kind: p.kind, service: p.service, ref });
    if (candidates.length >= MAX_LLM_CANDIDATES) {
      notes.push(`LLM suggestion ${label} dropped: limit of ${MAX_LLM_CANDIDATES} reached`);
      continue;
    }

    const anchored = CHANGE_KINDS.has(p.kind) ? anchorChange(p.kind, ref, evidence) : anchorCondition(p.kind, p.service, ref, evidence);
    if (!anchored) {
      notes.push(`LLM suggestion ${label} rejected: no evidence supports it`);
      continue;
    }
    const id = hypothesisId(anchored);
    if (known.has(id)) continue;
    known.add(id);
    candidates.push(anchored);
    notes.push(`LLM suggestion ${id} added`);
  }
  return { candidates, notes };
}

function anchorChange(kind: Candidate["kind"], ref: string | undefined, evidence: readonly Evidence[]): Candidate | undefined {
  for (const e of evidence) {
    const c = e.claim;
    if (c.kind !== "change" || c.subject.ref !== ref || !c.subject.service) continue;
    return { kind, service: c.subject.service, ref, start: c.value.at, title: `${kind} via ${c.subject.type} ${ref}`, origin: "llm" };
  }
  return undefined;
}

function anchorCondition(kind: Candidate["kind"], service: Candidate["service"], ref: string | undefined, evidence: readonly Evidence[]): Candidate | undefined {
  const starts: number[] = [];
  for (const e of evidence) {
    const c = e.claim;
    if (c.kind !== "log_pattern" || c.subject.service !== service) continue;
    if (mechanismsOf(`${c.subject.template} ${c.value.sample}`).some((m) => COMPATIBLE[kind].includes(m))) starts.push(c.value.firstSeen);
  }
  if (starts.length === 0) return undefined;
  return { kind, service, start: Math.min(...starts), title: `${kind} in ${service}`, origin: "llm", ...(ref !== undefined && { ref }) };
}
