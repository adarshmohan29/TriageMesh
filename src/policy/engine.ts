import type { DryRun, Tier } from "../registry/tool.js";
import type { ToolSpec } from "../registry/registry.js";
import type { Policy, PolicyRule } from "./policy.js";

export type Decision =
  | { allowed: true; requiresApproval: boolean; reason: string }
  | { allowed: false; reason: string };

export interface CallCheck {
  tool: Pick<ToolSpec, "name" | "tier">;
  role: string;
}

export interface DryRunCheck extends CallCheck {
  dryRun: DryRun;
  /** Successful writes already made by this invoker. */
  writesSoFar: number;
}

/**
 * Pure decision logic over a loaded Policy: no I/O, no tool calls, no LLM.
 * GuardedInvoker asks it twice for a write — before the dry run (may this
 * role use this tool at all?) and after (is this specific change in limits?).
 */
export class PolicyEngine {
  readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  /** Tiers a role may use; empty for an unknown role (deny by default). */
  allowedTiers(role: string): Tier[] {
    return this.policy.roles[role]?.tiers ?? [];
  }

  checkCall({ tool, role }: CallCheck): Decision {
    if (!(role in this.policy.roles)) return { allowed: false, reason: `unknown role "${role}"` };
    if (!this.allowedTiers(role).includes(tool.tier)) {
      return { allowed: false, reason: `role ${role} may not use ${tool.tier} tools` };
    }

    const matching = this.policy.rules.filter((r) => ruleApplies(r, tool.name, role));
    // Deny beats approval regardless of rule order.
    const deny = matching.find((r) => r.effect === "deny");
    if (deny) return { allowed: false, reason: `${deny.id}: ${deny.reason}` };

    const approvalRule = matching.find((r) => r.effect === "require_approval");
    if (tool.tier === "destructive") {
      return { allowed: true, requiresApproval: true, reason: "destructive tier requires approval" };
    }
    if (approvalRule) {
      return { allowed: true, requiresApproval: true, reason: `${approvalRule.id}: ${approvalRule.reason}` };
    }
    return { allowed: true, requiresApproval: false, reason: `role ${role} may use ${tool.tier} tools` };
  }

  /** Limits that depend on what the write would actually do. */
  checkDryRun(check: DryRunCheck): Decision {
    const call = this.checkCall(check);
    if (!call.allowed) return call;

    const { maxAffectedServices, maxWritesPerRun } = this.policy.limits;
    const affected = new Set(check.dryRun.affectedServices).size;
    if (affected > maxAffectedServices) {
      return {
        allowed: false,
        reason: `blast radius ${affected} services exceeds limit ${maxAffectedServices}`,
      };
    }
    if (check.writesSoFar >= maxWritesPerRun) {
      return { allowed: false, reason: `write limit reached (${maxWritesPerRun} per run)` };
    }
    return call;
  }
}

function ruleApplies(rule: PolicyRule, toolName: string, role: string): boolean {
  if (rule.roles && !rule.roles.includes(role)) return false;
  return rule.tools.some((pattern) => matchesPattern(pattern, toolName));
}

export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}
