import { unwrap } from "../../src/core/result.js";
import type { ApprovalCallback, ApprovalRequest } from "../../src/policy/approval.js";
import { denyAll } from "../../src/policy/approval.js";
import { AuditLog } from "../../src/policy/audit.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { GuardedInvoker } from "../../src/policy/invoker.js";
import { DEFAULT_POLICY_PATH, loadPolicyFile, type Policy } from "../../src/policy/policy.js";
import type { ToolRegistry } from "../../src/registry/registry.js";
import { createSimRegistry } from "../../src/tools/index.js";
import { makeWorld } from "../sim/helpers.js";

export function defaultPolicy(): Policy {
  return unwrap(loadPolicyFile(DEFAULT_POLICY_PATH));
}

/** An approval callback that records what it was asked. */
export function recordingApprover(approved: boolean): ApprovalCallback & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  const fn = async (request: ApprovalRequest) => {
    requests.push(request);
    return { approved, approver: approved ? "alice" : "bob" };
  };
  return Object.assign(fn, { requests });
}

export function makeInvoker(
  incident: string,
  options: { approve?: ApprovalCallback; policy?: Policy; registry?: ToolRegistry } = {},
) {
  const { world, clock } = makeWorld(incident);
  const audit = new AuditLog({ clock });
  const invoker = new GuardedInvoker({
    registry: options.registry ?? createSimRegistry(world),
    policy: new PolicyEngine(options.policy ?? defaultPolicy()),
    audit,
    approve: options.approve ?? denyAll,
  });
  return { world, clock, audit, invoker };
}
