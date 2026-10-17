import { z } from "zod";
import { EvidenceSourceSchema } from "../evidence/schema.js";
import { RootCauseKindSchema, ServiceSchema } from "../sim/types.js";

/** A possible root cause, before scoring. */
export const CandidateSchema = z.object({
  kind: RootCauseKindSchema,
  /** Where the cause lives (not necessarily where the alert fired). */
  service: ServiceSchema,
  /** Deploy id, flag name, config key, certificate or dependency name. */
  ref: z.string().optional(),
  /** When the cause began: the change time, or the first sign of the condition. */
  start: z.number().int(),
  title: z.string(),
  origin: z.enum(["rule", "llm"]),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** One piece of evidence counted for or against a hypothesis, and why. */
export const EvidenceLinkSchema = z.object({
  evidenceId: z.string(),
  /** Contribution to the score after trust, timing and agreement. */
  weight: z.number(),
  reason: z.string(),
});
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export const HypothesisSchema = CandidateSchema.extend({
  /** Stable id: kind, service and ref. Also the tie-breaker when ranking. */
  id: z.string(),
  rank: z.number().int().min(1),
  /** Σ support − Σ contradiction. */
  score: z.number(),
  /** Share of the positive score mass, 0..1. Comparable within one report only. */
  confidence: z.number().min(0).max(1),
  for: z.array(EvidenceLinkSchema),
  against: z.array(EvidenceLinkSchema),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/**
 * Two groups of evidence that disagree, and how the disagreement was settled.
 *  - value:    sources report different readings of the same metric.
 *  - presence: logs show errors that a metric says aren't there (or vice versa).
 *  - temporal: timestamps don't fit a causal story (a change after the
 *              symptom began, or a source whose clock is off).
 */
export const ConflictRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["value", "temporal", "presence"]),
  /** What the sides disagree about, e.g. "database.error_rate". */
  subject: z.string(),
  /** Evidence ids on each side. */
  a: z.array(z.string()).min(1),
  b: z.array(z.string()).min(1),
  resolution: z.enum(["trust_weighted", "cause_after_effect", "skew_corrected", "unresolved"]),
  winner: z.enum(["a", "b", "none"]),
  rationale: z.string(),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

export const ResolutionSchema = z.object({
  /** Best first; ties broken by id so the order is stable. */
  hypotheses: z.array(HypothesisSchema),
  conflicts: z.array(ConflictRecordSchema),
  /** Sources whose data was corrected or overruled. */
  flaggedSources: z.array(z.object({ source: EvidenceSourceSchema, reason: z.string() })),
  /** Evidence deliberately not used as support for anything (e.g. injected instructions). */
  ignored: z.array(z.object({ evidenceId: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/** What the LLM may propose. Code fills in start/title and scores it like any other. */
export const ProposedHypothesesSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        kind: RootCauseKindSchema,
        service: ServiceSchema,
        /** null when the cause has no specific ref. */
        ref: z.string().nullable(),
        rationale: z.string(),
      }),
    )
    .max(10),
});
export type ProposedHypotheses = z.infer<typeof ProposedHypothesesSchema>;
