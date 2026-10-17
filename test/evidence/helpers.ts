import { unwrap } from "../../src/core/result.js";
import { createRng } from "../../src/core/rng.js";
import { Executor, type ExecutionResult } from "../../src/executor/executor.js";
import { MockLlm } from "../../src/llm/mock.js";
import { denyAll } from "../../src/policy/approval.js";
import { AuditLog } from "../../src/policy/audit.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { GuardedInvoker } from "../../src/policy/invoker.js";
import { Planner } from "../../src/planner/planner.js";
import { Router } from "../../src/router/router.js";
import type { World } from "../../src/sim/world.js";
import { createSimRegistry } from "../../src/tools/index.js";
import { defaultPolicy } from "../policy/helpers.js";
import { makeWorld } from "../sim/helpers.js";

/** Plan (template) and execute an incident's investigation. */
export async function executeIncident(id: string, seed = 1): Promise<{ world: World; execution: ExecutionResult }> {
  const { world, clock } = makeWorld(id, seed);
  const registry = createSimRegistry(world);
  const policy = new PolicyEngine(defaultPolicy());
  const llm = new MockLlm();
  const invoker = new GuardedInvoker({ registry, policy, audit: new AuditLog({ clock }), approve: denyAll });
  const planner = new Planner({ registry, policy, llm, router: new Router({ registry, policy, llm }) });
  const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
  const pending = new Executor({ invoker, registry, clock, rng: createRng(seed) }).execute(plan, { role: "investigator" });
  await clock.runAll();
  return { world, execution: unwrap(await pending) };
}
