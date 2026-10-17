import { canonicalJson } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import type { LlmClient } from "../llm/client.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { Router } from "../router/router.js";
import type { Alert } from "../sim/types.js";
import { DraftPlanSchema, MAX_STEPS, type Plan, type Step } from "./plan.js";
import { templateNeeds, type Need } from "./template.js";
import { stepsFromDraft, validateSteps } from "./validate.js";

export interface PlannerDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  router: Router;
  llm: LlmClient;
}

export interface PlanOptions {
  role: string;
  signal?: AbortSignal;
}

export interface PlanError {
  code: "no_plan";
  message: string;
}

/**
 * Builds the investigation DAG. The LLM may draft a plan; code validates it
 * and tops it up with any core steps it left out. If the draft is missing or
 * invalid, the deterministic template plan is used instead (rule 7).
 */
export class Planner {
  readonly #deps: PlannerDeps;

  constructor(deps: PlannerDeps) {
    this.#deps = deps;
  }

  async plan(alert: Alert, options: PlanOptions): Promise<Result<Plan, PlanError>> {
    const { role } = options;
    const template = await this.#routeNeeds(templateNeeds(alert), options);
    const notes = [...template.notes];

    if (template.steps.length === 0) {
      return err({ code: "no_plan", message: `role ${role} has no tools to investigate with` });
    }
    const checkedTemplate = validateSteps(template.steps, role, this.#deps);
    if (!checkedTemplate.ok) {
      // The template is our code; if it's invalid that's a bug, not bad input.
      throw new Error(`template plan is invalid: ${checkedTemplate.error.join("; ")}`);
    }

    const drafted = await this.#draft(alert, role, options.signal);
    if (!drafted.ok) {
      notes.push(`using template plan: ${drafted.error}`);
      return ok({ alertId: alert.id, source: "template", notes, steps: template.steps });
    }

    const steps = [...drafted.value];
    for (const core of template.steps.filter((s) => template.coreIds.has(s.id))) {
      if (steps.some((s) => sameCall(s, core))) continue;
      if (steps.length >= MAX_STEPS) {
        notes.push(`plan full; could not add core step "${core.id}"`);
        continue;
      }
      steps.push({ ...core, id: uniqueId(core.id, steps) });
      notes.push(`added core step "${core.id}" missing from the LLM plan`);
    }
    return ok({ alertId: alert.id, source: "llm", notes, steps });
  }

  /** Ask the LLM for a plan; return validated steps or why it was rejected. */
  async #draft(alert: Alert, role: string, signal: AbortSignal | undefined): Promise<Result<Step[], string>> {
    const tools = this.#deps.registry
      .list({ tiers: ["read"] })
      .filter((spec) => this.#deps.policy.checkCall({ tool: spec, role }).allowed)
      .map(({ name, description, inputJsonSchema }) => ({ name, description, inputJsonSchema }));

    const reply = await this.#deps.llm.generate(
      {
        purpose: "planner.plan",
        instruction:
          "Plan an investigation of the alert as a DAG of read-only tool calls. Gather the evidence " +
          "needed to tell competing root causes apart (recent changes, metrics and logs of the " +
          `alerting service and what it depends on). Use at most ${MAX_STEPS} steps and only the ` +
          "listed tools. Each step's input is a JSON object string matching that tool's schema; times " +
          "are epoch milliseconds. Use dependsOn only when a step must wait for another.",
        data: [
          { label: "alert", content: alert },
          { label: "tools", content: tools },
        ],
        schema: DraftPlanSchema,
      },
      signal ? { signal } : {},
    );
    if (!reply.ok) return err(`LLM ${reply.error.code}: ${reply.error.message}`);

    const steps = stepsFromDraft(reply.value);
    if (!steps.ok) return err(`LLM plan rejected: ${steps.error.join("; ")}`);
    const checked = validateSteps(steps.value, role, this.#deps);
    return checked.ok ? checked : err(`LLM plan rejected: ${checked.error.join("; ")}`);
  }

  /** Resolve each need's capability to a tool via the router. */
  async #routeNeeds(needs: Need[], options: PlanOptions): Promise<{ steps: Step[]; coreIds: Set<string>; notes: string[] }> {
    const steps: Step[] = [];
    const coreIds = new Set<string>();
    const notes: string[] = [];
    for (const need of needs) {
      const route = await this.#deps.router.route(
        { capability: need.capability, role: options.role, goal: need.purpose },
        options.signal ? { signal: options.signal } : {},
      );
      if (!route.ok) {
        notes.push(`skipped "${need.id}": ${route.error.message}`);
        continue;
      }
      steps.push({ id: need.id, tool: route.value.tool, input: need.input, dependsOn: [], purpose: need.purpose });
      if (need.core) coreIds.add(need.id);
    }
    return { steps, coreIds, notes };
  }
}

/** Same tool with the same input, regardless of key order or step id. */
function sameCall(a: Step, b: Step): boolean {
  return a.tool === b.tool && canonicalJson(a.input) === canonicalJson(b.input);
}

function uniqueId(id: string, steps: readonly Step[]): string {
  let candidate = id;
  for (let n = 2; steps.some((s) => s.id === candidate); n++) candidate = `${id}-${n}`;
  return candidate;
}
