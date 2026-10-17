import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";
import type { LlmClient } from "../llm/client.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ToolRegistry, ToolSpec } from "../registry/registry.js";
import type { Capability, Tier } from "../registry/tool.js";

export interface RouteRequest {
  capability: Capability;
  role: string;
  /** What the step is trying to learn or do, in plain words. */
  goal: string;
}

export interface Route {
  tool: string;
  /** single = only one candidate, no LLM call; fallback = LLM failed or went off-list. */
  via: "single" | "llm" | "fallback";
  reason: string;
  shortlist: string[];
}

export interface RouteError {
  code: "no_tool";
  message: string;
}

export const PickSchema = z.object({
  tool: z.string(),
  reason: z.string(),
});

export interface RouterDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  llm: LlmClient;
}

const TIER_ORDER: Record<Tier, number> = { read: 0, reversible_write: 1, destructive: 2 };

/**
 * Picks one tool for a need. Code builds the shortlist (capability match,
 * the role's tiers, minus anything policy would deny outright); the LLM only
 * chooses *within* it. A pick outside the shortlist is discarded, and any
 * LLM failure falls back to the least-privileged candidate.
 *
 * The router is a convenience, not a control: whatever it picks still goes
 * through GuardedInvoker.
 */
export class Router {
  readonly #deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  shortlist(capability: Capability, role: string): ToolSpec[] {
    const { registry, policy } = this.#deps;
    return registry
      .list({ capability, tiers: policy.allowedTiers(role) })
      .filter((spec) => policy.checkCall({ tool: spec, role }).allowed)
      .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name));
  }

  async route(request: RouteRequest, options: { signal?: AbortSignal } = {}): Promise<Result<Route, RouteError>> {
    const candidates = this.shortlist(request.capability, request.role);
    const names = candidates.map((c) => c.name);
    const [first] = candidates;
    if (!first) {
      return err({ code: "no_tool", message: `no tool with ${request.capability} is available to role ${request.role}` });
    }
    if (candidates.length === 1) {
      return ok({ tool: first.name, via: "single", reason: "only candidate", shortlist: names });
    }

    const pick = await this.#deps.llm.generate(
      {
        purpose: "router.pick",
        instruction:
          "Choose the single best tool from the shortlist for the goal in the request. " +
          'Reply as {"tool": <name from the shortlist>, "reason": <one sentence>}.',
        data: [
          { label: "request", content: { capability: request.capability, goal: request.goal } },
          { label: "shortlist", content: candidates.map(({ name, description, tier }) => ({ name, description, tier })) },
        ],
        schema: PickSchema,
        maxTokens: 1024,
      },
      options,
    );

    if (!pick.ok) {
      return ok({ tool: first.name, via: "fallback", reason: `LLM ${pick.error.code}: ${pick.error.message}`, shortlist: names });
    }
    if (!names.includes(pick.value.tool)) {
      return ok({ tool: first.name, via: "fallback", reason: `LLM picked "${pick.value.tool}", not on the shortlist`, shortlist: names });
    }
    return ok({ tool: pick.value.tool, via: "llm", reason: pick.value.reason, shortlist: names });
  }
}
