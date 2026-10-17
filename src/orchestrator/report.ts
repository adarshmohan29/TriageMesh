import { z } from "zod";
import { EvidenceSchema } from "../evidence/schema.js";
import { StepErrorSchema } from "../executor/executor.js";
import { DryRunSchema, TierSchema } from "../registry/tool.js";
import { ResolutionSchema } from "../resolver/schema.js";
import { AlertSchema } from "../sim/types.js";

/**
 * A proposed fix, already checked against policy: the dry run shows what
 * it would change and `decision` says whether this role could run it.
 * Proposing never changes anything; only `apply` does, through GuardedInvoker.
 */
export const RemediationProposalSchema = z.object({
  id: z.string(),
  /** The hypothesis this would fix. */
  hypothesisId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  /** catalog: our code mapped the hypothesis to it. llm: suggested by the model (never auto-applied). */
  origin: z.enum(["catalog", "llm"]),
  /** fix removes the cause; mitigation only buys time. */
  effect: z.enum(["fix", "mitigation"]),
  /** null when the tool doesn't exist. */
  tier: TierSchema.nullable(),
  /** null when the dry run didn't happen (denied earlier) or failed. */
  preview: DryRunSchema.nullable(),
  decision: z.object({
    status: z.enum(["allowed", "needs_approval", "denied", "invalid", "dry_run_failed"]),
    reason: z.string(),
  }),
  /** Reasons to doubt the action fits the hypothesis, found by checking its dry run. */
  warnings: z.array(z.string()),
  /** The one action `--apply` would run. At most one proposal has this. */
  recommended: z.boolean(),
});
export type RemediationProposal = z.infer<typeof RemediationProposalSchema>;

export const ApplyResultSchema = z.object({
  status: z.enum(["applied", "not_approved", "denied", "failed", "skipped"]),
  proposalId: z.string().nullable(),
  tool: z.string().nullable(),
  message: z.string(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

/** Evidence without rawData: the report keeps typed claims, not raw tool output. */
export const EvidenceSummarySchema = EvidenceSchema.omit({ rawData: true });

export const InvestigationReportSchema = z.object({
  alert: AlertSchema,
  role: z.string(),
  /** Which LLM client was used ("mock" offline). */
  llm: z.string(),
  plan: z.object({
    source: z.enum(["template", "llm"]),
    notes: z.array(z.string()),
    steps: z.array(z.object({ id: z.string(), tool: z.string(), purpose: z.string(), dependsOn: z.array(z.string()) })),
  }),
  execution: z.object({
    startedAt: z.number().int(),
    finishedAt: z.number().int(),
    steps: z.array(
      z.object({
        stepId: z.string(),
        tool: z.string(),
        status: z.enum(["ok", "failed", "skipped"]),
        attempts: z.number().int(),
        hedged: z.boolean(),
        startedAt: z.number().int(),
        finishedAt: z.number().int(),
        error: StepErrorSchema.optional(),
      }),
    ),
  }),
  evidence: z.array(EvidenceSummarySchema),
  evidenceNotes: z.array(z.string()),
  resolution: ResolutionSchema,
  remediations: z.array(RemediationProposalSchema),
  remediationNotes: z.array(z.string()),
  /** Present when the caller asked to apply the recommended remediation. */
  applied: ApplyResultSchema.nullable(),
  stats: z.object({
    /** Tool runs (not counting denied attempts or dry runs). */
    toolCalls: z.number().int(),
    llmCalls: z.number().int(),
    policyDenials: z.number().int(),
    /** Virtual (or real) ms from the first step starting to the last finishing. */
    executionMs: z.number().int(),
  }),
  audit: z.object({
    entries: z.number().int(),
    /** The hash chain verified end to end. */
    chainValid: z.boolean(),
    lastHash: z.string().nullable(),
  }),
});
export type InvestigationReport = z.infer<typeof InvestigationReportSchema>;
