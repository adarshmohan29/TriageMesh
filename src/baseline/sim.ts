import { err, ok, type Result } from "../core/result.js";
import { MockLlm } from "../llm/mock.js";
import { denyAll } from "../policy/approval.js";
import { DEFAULT_ROLE, MOCK_RESPONDERS, simEnvironment, type IncidentRunError, type IncidentRunOptions } from "../orchestrator/sim.js";
import type { World } from "../sim/world.js";
import { mockBaselineResponder } from "./mock.js";
import { ReactBaseline, type BaselineReport } from "./react.js";

/** The baseline's offline LLM: the shared mocks plus its own scripted agent. */
export const BASELINE_MOCK_RESPONDERS = { ...MOCK_RESPONDERS, "baseline.step": mockBaselineResponder };

/** Run the ReAct baseline on a scripted incident, in the same environment the orchestrator gets. */
export async function baselineIncident(
  options: Omit<IncidentRunOptions, "apply"> & { maxSteps?: number },
): Promise<Result<{ report: BaselineReport; world: World }, IncidentRunError>> {
  const env = simEnvironment({ ...options, llm: options.llm ?? new MockLlm(BASELINE_MOCK_RESPONDERS) });
  if (!env.ok) return err(env.error);
  const { world, registry, policy, audit, llm } = env.value;
  const baseline = new ReactBaseline({ registry, policy, audit, approve: options.approve ?? denyAll, llm, clock: world.clock });
  const report = await baseline.investigate(world.alert, {
    role: options.role ?? DEFAULT_ROLE,
    ...(options.maxSteps !== undefined && { maxSteps: options.maxSteps }),
  });
  return ok({ report, world });
}
