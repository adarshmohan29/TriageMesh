import { z } from "zod";

export const MAX_STEPS = 30;

export const StepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "step ids are lowercase, e.g. deploys or metric-api-error_rate");

/**
 * One DAG node: invoke `tool` with `input` once every step in `dependsOn`
 * has finished. Inputs are static; dependencies only order execution (and
 * let the executor skip dependents of a failed step).
 */
export const StepSchema = z.object({
  id: StepIdSchema,
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  dependsOn: z.array(StepIdSchema).default([]),
  /** Why this step is in the plan, shown in reports. */
  purpose: z.string(),
});
export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z.object({
  alertId: z.string(),
  source: z.enum(["llm", "template"]),
  /** Fallback reasons, coverage steps added, steps skipped. */
  notes: z.array(z.string()),
  steps: z.array(StepSchema).min(1).max(MAX_STEPS),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * What the LLM is asked to return. `input` is a JSON *string* because strict
 * structured outputs handle fixed shapes better than free-form objects; code
 * parses it and then checks it against the tool's own input schema.
 */
export const DraftPlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string(),
        tool: z.string(),
        input: z.string().describe("The tool input as a JSON object, encoded as a string"),
        dependsOn: z.array(z.string()),
        purpose: z.string(),
      }),
    )
    .min(1)
    .max(MAX_STEPS),
});
export type DraftPlan = z.infer<typeof DraftPlanSchema>;
