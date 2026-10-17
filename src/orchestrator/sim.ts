import { err, ok, type Result } from "../core/result.js";
import { createRng } from "../core/rng.js";
import type { LlmClient } from "../llm/client.js";
import { MeteredLlm } from "../llm/metered.js";
import { MockLlm, type MockResponders } from "../llm/mock.js";
import { mockPlannerResponder } from "../planner/mock.js";
import { denyAll, type ApprovalCallback } from "../policy/approval.js";
import { AuditLog } from "../policy/audit.js";
import { PolicyEngine } from "../policy/engine.js";
import { DEFAULT_POLICY_PATH, loadPolicyFile, type Policy } from "../policy/policy.js";
import { mockRouterResponder } from "../router/mock.js";
import { getIncident, INCIDENT_IDS } from "../sim/incidents/index.js";
import { World } from "../sim/world.js";
import type { ToolRegistry } from "../registry/registry.js";
import { createSimRegistry } from "../tools/index.js";
import { DEFAULT_LATENCY, SimLatency, type LatencyProfile } from "../tools/latency.js";
import { Orchestrator, type InvestigationError } from "./orchestrator.js";
import type { InvestigationReport } from "./report.js";

/** Offline LLM behaviour for every purpose that has a mock (rule 6). */
export const MOCK_RESPONDERS: MockResponders = {
  "router.pick": mockRouterResponder,
  "planner.plan": mockPlannerResponder,
};

/** Can propose reversible fixes; destructive ones need incident_commander. */
export const DEFAULT_ROLE = "responder";

/** Simulated latency for tools and the LLM, on the world's virtual clock. */
export interface SimLatencyOptions {
  tools: LatencyProfile;
  /** Added to every LLM call. Only meaningful for the mock; real calls take real time. */
  llmMs: number;
}

export const DEFAULT_SIM_LATENCY: SimLatencyOptions = { tools: DEFAULT_LATENCY, llmMs: 1_200 };

export interface IncidentRunOptions {
  incident: string;
  seed?: number;
  role?: string;
  apply?: boolean;
  /** Defaults to denyAll: with nobody to ask, the answer is no. */
  approve?: ApprovalCallback;
  /** Defaults to MockLlm with MOCK_RESPONDERS. */
  llm?: LlmClient;
  /** Defaults to policies/default.yaml. */
  policy?: Policy;
  /** Receives each audit entry as a JSONL line. */
  auditSink?: (line: string) => void;
  /** Omitted: tools and the LLM answer instantly. */
  latency?: SimLatencyOptions;
  signal?: AbortSignal;
}

export interface IncidentRun {
  report: InvestigationReport;
  /** The simulated world after the investigation (and any applied fix). */
  world: World;
  audit: AuditLog;
}

export type IncidentRunError = InvestigationError | { code: "unknown_incident" | "bad_policy"; message: string };

/** Everything an investigator needs to work on one simulated incident. */
export interface SimEnvironment {
  world: World;
  registry: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLog;
  llm: LlmClient;
  seed: number;
}

/**
 * Build a fresh world and its tools, policy, audit log and LLM. Shared by
 * the orchestrator and the ReAct baseline so both face identical conditions.
 */
export function simEnvironment(options: IncidentRunOptions): Result<SimEnvironment, IncidentRunError> {
  const script = getIncident(options.incident);
  if (!script) return err({ code: "unknown_incident", message: `unknown incident "${options.incident}" (known: ${INCIDENT_IDS.join(", ")})` });

  let policy = options.policy;
  if (!policy) {
    const loaded = loadPolicyFile(DEFAULT_POLICY_PATH);
    if (!loaded.ok) return err({ code: "bad_policy", message: loaded.error });
    policy = loaded.value;
  }

  const seed = options.seed ?? 1;
  const world = new World({ incident: script, seed });
  const latency = options.latency;
  const registry = createSimRegistry(world, latency ? { latency: new SimLatency(world.clock, createRng(seed).fork("latency"), latency.tools) } : {});
  const baseLlm = options.llm ?? new MockLlm(MOCK_RESPONDERS);
  const llm = latency?.llmMs ? new MeteredLlm(baseLlm, { clock: world.clock, latencyMs: latency.llmMs }) : baseLlm;
  const audit = new AuditLog({ clock: world.clock, ...(options.auditSink && { sink: options.auditSink }) });
  return ok({ world, registry, policy: new PolicyEngine(policy), audit, llm, seed });
}

/** Investigate one of the scripted incidents end to end. Same options => same report. */
export async function investigateIncident(options: IncidentRunOptions): Promise<Result<IncidentRun, IncidentRunError>> {
  const env = simEnvironment(options);
  if (!env.ok) return env;
  const { world, registry, policy, audit, llm, seed } = env.value;
  const orchestrator = new Orchestrator({
    registry,
    policy,
    audit,
    approve: options.approve ?? denyAll,
    llm,
    clock: world.clock,
    rng: createRng(seed),
  });

  const report = await orchestrator.investigate(world.alert, {
    role: options.role ?? DEFAULT_ROLE,
    ...(options.apply !== undefined && { apply: options.apply }),
    ...(options.signal && { signal: options.signal }),
  });
  return report.ok ? ok({ report: report.value, world, audit }) : report;
}
