import pLimit from "p-limit";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { err, ok, type Result } from "../core/result.js";
import type { Rng } from "../core/rng.js";
import { InvokeErrorSchema, type InvokeError, type InvokeOptions, type InvokeSuccess } from "../policy/invoker.js";
import { dagIssues } from "../planner/dag.js";
import type { Plan, Step } from "../planner/plan.js";
import type { ToolRegistry } from "../registry/registry.js";

export interface ExecutorConfig {
  /** Max steps running at once. */
  concurrency: number;
  /** Per attempt. A timed-out attempt is aborted and may be retried. */
  timeoutMs: number;
  /** Extra attempts after the first, for retryable failures of read steps. */
  retries: number;
  /** Backoff before retry n is baseBackoffMs * 2^(n-1) plus up to baseBackoffMs of jitter. */
  baseBackoffMs: number;
  /** Start a duplicate attempt if the first is still running after this long; undefined disables. */
  hedgeAfterMs: number | undefined;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  concurrency: 4,
  timeoutMs: 5_000,
  retries: 2,
  baseBackoffMs: 200,
  hedgeAfterMs: 1_500,
};

/** The part of GuardedInvoker the executor needs; tools are only reached through it. */
export interface Invoker {
  invoke(name: string, input: unknown, options: InvokeOptions): Promise<Result<InvokeSuccess, InvokeError>>;
}

export interface ExecutorDeps {
  invoker: Invoker;
  /** Used to look up a step's tier: only reads are retried or hedged. */
  registry: ToolRegistry;
  clock: Clock;
  rng: Rng;
  config?: Partial<ExecutorConfig>;
}

export const StepErrorSchema = z.object({
  code: z.union([InvokeErrorSchema.shape.code, z.enum(["timeout", "aborted", "dependency_failed"])]),
  message: z.string(),
});
export type StepError = z.infer<typeof StepErrorSchema>;

export interface StepResult {
  stepId: string;
  tool: string;
  status: "ok" | "failed" | "skipped";
  output?: unknown;
  error?: StepError;
  /** Tool invocations made, including retries and hedges. */
  attempts: number;
  hedged: boolean;
  startedAt: number;
  finishedAt: number;
}

export interface ExecutionResult {
  /** In plan order, whatever order steps finished in. */
  steps: StepResult[];
  startedAt: number;
  finishedAt: number;
}

/** Failures worth another try. Denials, bad input and bad output won't change on retry. */
const RETRYABLE = new Set<StepError["code"]>(["timeout", "tool_error"]);

type Attempt = Result<InvokeSuccess, StepError>;

/**
 * Runs a plan's DAG: each step waits for its dependencies, then for a slot
 * under the concurrency limit. All waiting goes through the injected Clock,
 * so with a VirtualClock timeouts, backoff and hedging are deterministic and
 * instant in tests.
 */
export class Executor {
  readonly #deps: ExecutorDeps;
  readonly #config: ExecutorConfig;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
    this.#config = { ...DEFAULT_EXECUTOR_CONFIG, ...deps.config };
  }

  async execute(plan: Plan, options: { role: string; signal?: AbortSignal }): Promise<Result<ExecutionResult, string[]>> {
    const issues = dagIssues(plan.steps);
    if (issues.length > 0) return err(issues);

    const { clock } = this.#deps;
    const startedAt = clock.now();
    const limit = pLimit(this.#config.concurrency);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const running = new Map<string, Promise<StepResult>>();

    // Memoised so each step runs once however many dependents await it.
    // dagIssues above guarantees this recursion terminates.
    const run = (step: Step): Promise<StepResult> => {
      let promise = running.get(step.id);
      if (!promise) {
        promise = (async () => {
          const deps = await Promise.all(step.dependsOn.map((id) => run(byId.get(id) as Step)));
          const failed = deps.find((d) => d.status !== "ok");
          if (failed) {
            const now = clock.now();
            const error: StepError = { code: "dependency_failed", message: `dependency "${failed.stepId}" did not succeed` };
            return { stepId: step.id, tool: step.tool, status: "skipped", error, attempts: 0, hedged: false, startedAt: now, finishedAt: now };
          }
          return limit(() => this.#runStep(step, options));
        })();
        running.set(step.id, promise);
      }
      return promise;
    };

    const steps = await Promise.all(plan.steps.map(run));
    return ok({ steps, startedAt, finishedAt: clock.now() });
  }

  async #runStep(step: Step, options: { role: string; signal?: AbortSignal }): Promise<StepResult> {
    const { clock, rng, registry } = this.#deps;
    const startedAt = clock.now();
    const base = { stepId: step.id, tool: step.tool, startedAt };
    const idempotent = registry.get(step.tool)?.tier === "read";
    const maxAttempts = idempotent ? 1 + this.#config.retries : 1;
    let attempts = 0;
    let hedged = false;
    let last: Attempt | undefined;

    for (let n = 1; n <= maxAttempts; n++) {
      if (options.signal?.aborted) {
        last = err({ code: "aborted", message: "investigation aborted" });
        break;
      }
      if (n > 1) {
        const backoff = this.#config.baseBackoffMs * 2 ** (n - 2) + rng.int(0, this.#config.baseBackoffMs);
        const slept = await sleepOrAbort(clock, backoff, options.signal);
        if (!slept) continue; // loop top reports the abort
      }
      const outcome = await this.#attemptWithHedge(step, options, idempotent);
      attempts += outcome.attempts;
      hedged ||= outcome.hedged;
      last = outcome.result;
      if (last.ok || !RETRYABLE.has(last.error.code)) break;
    }

    const finishedAt = clock.now();
    if (last?.ok) return { ...base, status: "ok", output: last.value.output, attempts, hedged, finishedAt };
    const error = last?.ok === false ? last.error : { code: "aborted" as const, message: "not attempted" };
    return { ...base, status: "failed", error, attempts, hedged, finishedAt };
  }

  /**
   * One logical attempt. If it's still running after hedgeAfterMs, a second
   * identical call starts and the first success wins; the loser is aborted.
   * Tail latency comes from the occasional slow call, so a duplicate usually
   * finishes well before the straggler. Only safe because reads are idempotent.
   */
  async #attemptWithHedge(
    step: Step,
    options: { role: string; signal?: AbortSignal },
    idempotent: boolean,
  ): Promise<{ result: Attempt; attempts: number; hedged: boolean }> {
    const hedgeAfter = this.#config.hedgeAfterMs;
    const primary = this.#attempt(step, options);
    if (!idempotent || hedgeAfter === undefined || hedgeAfter >= this.#config.timeoutMs) {
      return { result: await primary.result, attempts: 1, hedged: false };
    }

    const timer = new AbortController();
    const fired = this.#deps.clock.sleep(hedgeAfter, timer.signal).then(
      () => "hedge" as const,
      () => "cancelled" as const,
    );
    const first = await Promise.race([primary.result, fired]);
    if (first !== "hedge" && first !== "cancelled") {
      timer.abort();
      return { result: first, attempts: 1, hedged: false };
    }

    const hedge = this.#attempt(step, options);
    const result = await firstOk([primary, hedge]);
    return { result, attempts: 2, hedged: true };
  }

  /** One tool call with its own timeout and abort controller. */
  #attempt(step: Step, options: { role: string; signal?: AbortSignal }): { result: Promise<Attempt>; abort: () => void } {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onParentAbort, { once: true });

    const result = (async (): Promise<Attempt> => {
      const timer = new AbortController();
      const timedOut = this.#deps.clock.sleep(this.#config.timeoutMs, timer.signal).then(
        () => "timeout" as const,
        () => "cancelled" as const,
      );
      const call = this.#deps.invoker.invoke(step.tool, step.input, { role: options.role, signal: controller.signal });
      const outcome = await Promise.race([call, timedOut]);
      timer.abort();
      options.signal?.removeEventListener("abort", onParentAbort);

      if (outcome === "timeout") {
        controller.abort(new Error("timeout"));
        return err({ code: "timeout", message: `${step.tool} did not finish within ${this.#config.timeoutMs}ms` });
      }
      if (outcome === "cancelled") return err({ code: "aborted", message: "aborted" });
      if (outcome.ok) return outcome;
      if (options.signal?.aborted) return err({ code: "aborted", message: "investigation aborted" });
      return err({ code: outcome.error.code, message: outcome.error.message });
    })();
    return { result, abort: () => controller.abort(new Error("hedge lost")) };
  }
}

/** First successful attempt wins and the rest are aborted; if all fail, the first one's error. */
async function firstOk(attempts: { result: Promise<Attempt>; abort: () => void }[]): Promise<Attempt> {
  const winner = await new Promise<number | undefined>((resolve) => {
    let pending = attempts.length;
    attempts.forEach((a, i) =>
      a.result.then((r) => {
        if (r.ok) resolve(i);
        else if (--pending === 0) resolve(undefined);
      }),
    );
  });
  if (winner === undefined) return (await attempts[0]?.result) as Attempt;
  attempts.forEach((a, i) => i !== winner && a.abort());
  return (await attempts[winner]?.result) as Attempt;
}

/** True if the full delay elapsed, false if aborted first. */
async function sleepOrAbort(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await clock.sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}
