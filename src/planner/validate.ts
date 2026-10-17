import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ToolRegistry } from "../registry/registry.js";
import { dagIssues } from "./dag.js";
import { DraftPlanSchema, MAX_STEPS, StepSchema, type DraftPlan, type Step } from "./plan.js";

export interface PlanCheckDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
}

/**
 * Everything code requires of a plan before running it. Planning is
 * investigation only, so every step must be a read the role may use;
 * remediation is proposed separately and gated on its own.
 */
export function validateSteps(steps: readonly Step[], role: string, deps: PlanCheckDeps): Result<Step[], string[]> {
  const issues: string[] = [];
  if (steps.length === 0) issues.push("plan has no steps");
  if (steps.length > MAX_STEPS) issues.push(`plan has ${steps.length} steps (max ${MAX_STEPS})`);
  issues.push(...dagIssues(steps));

  for (const step of steps) {
    const tool = deps.registry.get(step.tool);
    if (!tool) {
      issues.push(`step "${step.id}": unknown tool "${step.tool}"`);
      continue;
    }
    if (tool.tier !== "read") issues.push(`step "${step.id}": ${step.tool} is a ${tool.tier} tool; plans may only read`);
    const decision = deps.policy.checkCall({ tool, role });
    if (!decision.allowed) issues.push(`step "${step.id}": ${decision.reason}`);
    const input = tool.inputSchema.safeParse(step.input);
    if (!input.success) issues.push(`step "${step.id}": invalid input for ${step.tool}: ${z.prettifyError(input.error)}`);
  }
  return issues.length === 0 ? ok([...steps]) : err(issues);
}

/** Turn the LLM's draft into Steps: parse each JSON input string, check ids. */
export function stepsFromDraft(draft: DraftPlan): Result<Step[], string[]> {
  const issues: string[] = [];
  const steps: Step[] = [];
  for (const raw of DraftPlanSchema.parse(draft).steps) {
    let input: unknown;
    try {
      input = JSON.parse(raw.input);
    } catch {
      issues.push(`step "${raw.id}": input is not valid JSON`);
      continue;
    }
    const step = StepSchema.safeParse({ ...raw, input });
    if (step.success) steps.push(step.data);
    else issues.push(`step "${raw.id}": ${z.prettifyError(step.error)}`);
  }
  return issues.length === 0 ? ok(steps) : err(issues);
}
