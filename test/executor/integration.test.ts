import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { createRng } from "../../src/core/rng.js";
import { Executor } from "../../src/executor/executor.js";
import { MockLlm } from "../../src/llm/mock.js";
import { denyAll } from "../../src/policy/approval.js";
import { AuditLog, verifyAuditChain } from "../../src/policy/audit.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { GuardedInvoker } from "../../src/policy/invoker.js";
import { mockPlannerResponder } from "../../src/planner/mock.js";
import { Planner } from "../../src/planner/planner.js";
import { mockRouterResponder } from "../../src/router/mock.js";
import { Router } from "../../src/router/router.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { createSimRegistry } from "../../src/tools/index.js";
import { defaultPolicy } from "../policy/helpers.js";
import { makeWorld } from "../sim/helpers.js";

async function investigate(id: string) {
  const { world, clock } = makeWorld(id);
  const registry = createSimRegistry(world);
  const policy = new PolicyEngine(defaultPolicy());
  const llm = new MockLlm({ "router.pick": mockRouterResponder, "planner.plan": mockPlannerResponder });
  const audit = new AuditLog({ clock });
  const invoker = new GuardedInvoker({ registry, policy, audit, approve: denyAll });
  const planner = new Planner({ registry, policy, llm, router: new Router({ registry, policy, llm }) });
  const executor = new Executor({ invoker, registry, clock, rng: createRng(1) });

  const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
  const pending = executor.execute(plan, { role: "investigator" });
  await clock.runAll();
  return { plan, result: unwrap(await pending), audit, world };
}

describe.each(INCIDENTS.map((i) => [i.id]))("executing the %s plan", (id) => {
  it("completes every step through the policy layer", async () => {
    const { plan, result, audit } = await investigate(id);
    expect(result.steps.filter((s) => s.status !== "ok")).toEqual([]);
    expect(audit.entries().filter((e) => e.kind === "result")).toHaveLength(plan.steps.length);
    expect(verifyAuditChain(audit.entries()).ok).toBe(true);
  });

  it("finds the incident's signature log", async () => {
    const { result, world } = await investigate(id);
    const lines = result.steps
      .filter((s) => s.tool === "logs.search")
      .flatMap((s) => (s.output as { lines: { message: string }[] }).lines);
    expect(lines.some((l) => l.message.includes(world.incident.signatureLog))).toBe(true);
  });
});
