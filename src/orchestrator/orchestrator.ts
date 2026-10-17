import { settle, type Clock } from "../core/clock.js";
import { err, ok, type Result } from "../core/result.js";
import type { Rng } from "../core/rng.js";
import { extractEvidence } from "../evidence/extract.js";
import { Executor, type ExecutorConfig } from "../executor/executor.js";
import type { LlmClient } from "../llm/client.js";
import { MeteredLlm } from "../llm/metered.js";
import type { ApprovalCallback } from "../policy/approval.js";
import { verifyAuditChain, type AuditLog } from "../policy/audit.js";
import type { PolicyEngine } from "../policy/engine.js";
import { GuardedInvoker } from "../policy/invoker.js";
import { Planner } from "../planner/planner.js";
import type { ToolRegistry } from "../registry/registry.js";
import { Resolver } from "../resolver/resolver.js";
import { Router } from "../router/router.js";
import type { Alert } from "../sim/types.js";
import { factsFrom, proposeRemediations } from "./remediation.js";
import type { ApplyResult, InvestigationReport, RemediationProposal } from "./report.js";

export interface OrchestratorDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLog;
  /** Asked before any write that policy says needs a human. Never an LLM. */
  approve: ApprovalCallback;
  llm: LlmClient;
  clock: Clock;
  rng: Rng;
  executor?: Partial<ExecutorConfig>;
}

export interface InvestigateOptions {
  role: string;
  /** Run the recommended remediation (still through policy, approval and the audit log). */
  apply?: boolean;
  signal?: AbortSignal;
}

export interface InvestigationError {
  code: "no_plan" | "invalid_plan";
  message: string;
}

/**
 * alert -> plan -> execute -> evidence -> resolve -> remediation proposals
 * [-> apply]. Each stage is its own module; this one wires them together and
 * assembles the report. Every tool call (reads, previews, the optional
 * apply) goes through one GuardedInvoker per investigation.
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /**
   * Drives the clock for the whole investigation: tool latency, LLM latency
   * and executor timeouts all wait on it (see settle()).
   */
  investigate(alert: Alert, options: InvestigateOptions): Promise<Result<InvestigationReport, InvestigationError>> {
    return settle(this.#deps.clock, this.#investigate(alert, options));
  }

  async #investigate(alert: Alert, options: InvestigateOptions): Promise<Result<InvestigationReport, InvestigationError>> {
    const { registry, policy, audit, approve, clock, rng } = this.#deps;
    const { role, signal } = options;
    const signalOpt = signal ? { signal } : {};
    const began = clock.now();
    const llm = new MeteredLlm(this.#deps.llm);
    const invoker = new GuardedInvoker({ registry, policy, audit, approve });

    const router = new Router({ registry, policy, llm });
    const plan = await new Planner({ registry, policy, llm, router }).plan(alert, { role, ...signalOpt });
    if (!plan.ok) return err({ code: "no_plan", message: plan.error.message });

    const executor = new Executor({ invoker, registry, clock, rng, ...(this.#deps.executor && { config: this.#deps.executor }) });
    const execution = await executor.execute(plan.value, { role, ...signalOpt });
    if (!execution.ok) return err({ code: "invalid_plan", message: execution.error.join("; ") });

    const { evidence, notes: evidenceNotes } = extractEvidence(execution.value);
    const resolution = await new Resolver({ llm }).resolve(alert, evidence, signalOpt);
    const { proposals, notes: remediationNotes } = await proposeRemediations(
      alert,
      resolution,
      evidence,
      factsFrom(execution.value),
      { invoker, registry, llm },
      { role, ...signalOpt },
    );
    const applied = options.apply ? await applyRecommended(invoker, proposals, role, signal) : null;

    const entries = audit.entries();
    const { startedAt, finishedAt, steps } = execution.value;
    return ok({
      alert,
      role,
      llm: this.#deps.llm.name,
      plan: {
        source: plan.value.source,
        notes: plan.value.notes,
        steps: plan.value.steps.map(({ id, tool, purpose, dependsOn }) => ({ id, tool, purpose, dependsOn })),
      },
      execution: {
        startedAt,
        finishedAt,
        steps: steps.map(({ stepId, tool, status, attempts, hedged, startedAt, finishedAt, error }) => ({
          stepId,
          tool,
          status,
          attempts,
          hedged,
          startedAt,
          finishedAt,
          ...(error && { error }),
        })),
      },
      evidence: evidence.map(({ rawData: _raw, ...summary }) => summary),
      evidenceNotes,
      resolution,
      remediations: proposals,
      remediationNotes,
      applied,
      stats: {
        toolCalls: entries.filter((e) => e.kind === "result").length,
        llmCalls: llm.usage.calls,
        llmTokens: llm.usage.inputTokens + llm.usage.outputTokens,
        policyDenials: entries.filter((e) => e.kind === "deny").length,
        executionMs: finishedAt - startedAt,
        elapsedMs: clock.now() - began,
      },
      audit: { entries: entries.length, chainValid: verifyAuditChain(entries).ok, lastHash: entries.at(-1)?.hash ?? null },
    });
  }
}

/** Run the one recommended proposal. Policy, dry run and approval all apply again. */
async function applyRecommended(
  invoker: GuardedInvoker,
  proposals: readonly RemediationProposal[],
  role: string,
  signal: AbortSignal | undefined,
): Promise<ApplyResult> {
  const chosen = proposals.find((p) => p.recommended);
  if (!chosen) return { status: "skipped", proposalId: null, tool: null, message: "no remediation was recommended" };
  const ran = await invoker.invoke(chosen.tool, chosen.input, signal ? { role, signal } : { role });
  const base = { proposalId: chosen.id, tool: chosen.tool };
  if (ran.ok) return { ...base, status: "applied", message: ran.value.dryRun?.summary ?? `${chosen.tool} ran` };
  const status = ran.error.code === "not_approved" ? "not_approved" : ran.error.code === "denied" ? "denied" : "failed";
  return { ...base, status, message: ran.error.message };
}
