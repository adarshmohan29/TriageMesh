import { z } from "zod";
import { baselineIncident } from "../baseline/sim.js";
import type { LlmClient } from "../llm/client.js";
import { DEFAULT_SIM_LATENCY, investigateIncident, type SimLatencyOptions } from "../orchestrator/sim.js";
import { INCIDENT_IDS } from "../sim/incidents/index.js";
import type { GroundTruth } from "../sim/types.js";

export const SYSTEMS = ["orchestrator", "baseline"] as const;
export type System = (typeof SYSTEMS)[number];

export const RunRecordSchema = z.object({
  system: z.enum(SYSTEMS),
  incident: z.string(),
  seed: z.number().int(),
  /** "kind:service:ref" of the top answer, or null if none. */
  answer: z.string().nullable(),
  top1: z.boolean(),
  top3: z.boolean(),
  /** Virtual ms for the whole investigation. */
  elapsedMs: z.number().int(),
  toolCalls: z.number().int(),
  llmCalls: z.number().int(),
  llmTokens: z.number().int(),
  /** Tokens the API actually billed, when the LLM reports them (real models only). */
  billedTokens: z.number().int().nullable(),
  /** Real elapsed ms, when a wall clock was supplied (real-model runs). */
  wallMs: z.number().int().nullable(),
  /** How the run went: "plan:llm" / "plan:template" (orchestrator) or why the baseline stopped. */
  outcome: z.string(),
  policyDenials: z.number().int(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const SummarySchema = z.object({
  system: z.enum(SYSTEMS),
  runs: z.number().int(),
  top1: z.number(),
  top3: z.number(),
  meanElapsedMs: z.number(),
  p95ElapsedMs: z.number(),
  meanToolCalls: z.number(),
  meanLlmCalls: z.number(),
  meanLlmTokens: z.number(),
  meanBilledTokens: z.number().nullable(),
  meanWallMs: z.number().nullable(),
  policyDenials: z.number().int(),
});
export type Summary = z.infer<typeof SummarySchema>;

export const BenchResultSchema = z.object({
  config: z.object({ seeds: z.array(z.number().int()), incidents: z.array(z.string()), role: z.string(), llm: z.string(), latency: z.unknown() }),
  summary: z.array(SummarySchema),
  runs: z.array(RunRecordSchema),
});
export type BenchResult = z.infer<typeof BenchResultSchema>;

export interface BenchOptions {
  seeds: number[];
  incidents?: string[];
  role?: string;
  latency?: SimLatencyOptions;
  /** A fresh LLM per run. Defaults to the offline mocks. */
  makeLlm?: () => LlmClient;
  /** Real time in ms, for real-model runs where LLM calls take real time. Never used in mock runs. */
  wallClock?: () => number;
}

/**
 * Run the orchestrator and the ReAct baseline over every incident x seed,
 * in identical simulated environments (same world, tools, policy, latency).
 * Everything runs on virtual clocks, so the numbers are exact and the same
 * on every machine. Mock LLM only: a real model isn't deterministic.
 */
export async function runBenchmark(options: BenchOptions): Promise<BenchResult> {
  const incidents = options.incidents ?? INCIDENT_IDS;
  const role = options.role ?? "responder";
  const latency = options.latency ?? DEFAULT_SIM_LATENCY;
  const runs: RunRecord[] = [];
  let llmName = "mock";

  // Times one run with the wall clock, if there is one.
  const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; wallMs: number | null }> => {
    const start = options.wallClock?.();
    const value = await work();
    return { value, wallMs: start === undefined || !options.wallClock ? null : Math.round(options.wallClock() - start) };
  };

  for (const incident of incidents) {
    for (const seed of options.seeds) {
      const orchestratorLlm = options.makeLlm?.();
      const orchestrated = await timed(() => investigateIncident({ incident, seed, role, latency, ...(orchestratorLlm && { llm: orchestratorLlm }) }));
      if (!orchestrated.value.ok) throw new Error(`orchestrator failed on ${incident}/${seed}: ${orchestrated.value.error.message}`);
      const { report, world } = orchestrated.value.value;
      llmName = report.llm;
      const ranked = report.resolution.hypotheses.map((h) => key(h.kind, h.service, h.ref ?? null));
      runs.push(
        record("orchestrator", incident, seed, ranked, world.groundTruth, report.stats, {
          wallMs: orchestrated.wallMs,
          billedTokens: billed(orchestratorLlm),
          outcome: `plan:${report.plan.source}`,
        }),
      );

      const baselineLlm = options.makeLlm?.();
      const baseline = await timed(() => baselineIncident({ incident, seed, role, latency, ...(baselineLlm && { llm: baselineLlm }) }));
      if (!baseline.value.ok) throw new Error(`baseline failed on ${incident}/${seed}: ${baseline.value.error.message}`);
      const b = baseline.value.value.report;
      const answers = b.answer.map((a) => key(a.kind, a.service, a.ref));
      runs.push(
        record("baseline", incident, seed, answers, baseline.value.value.world.groundTruth, b.stats, {
          wallMs: baseline.wallMs,
          billedTokens: billed(baselineLlm),
          outcome: b.stoppedBecause,
        }),
      );
    }
  }

  return {
    config: { seeds: options.seeds, incidents: [...incidents], role, llm: llmName, latency },
    summary: SYSTEMS.map((system) => summarise(system, runs.filter((r) => r.system === system))),
    runs,
  };
}

/**
 * Real billed tokens, for clients that report them (AnthropicLlm). A real
 * client with no successful call means every request failed (usually
 * missing credentials). The orchestrator would quietly fall back to its
 * deterministic path and look fine, so that is an error, not a result.
 */
function billed(llm: LlmClient | undefined): number | null {
  const usage = (llm as { usage?: { calls: number; inputTokens: number; outputTokens: number } } | undefined)?.usage;
  if (!usage) return null;
  if (usage.calls === 0) throw new Error(`${llm?.name} answered no requests; check ANTHROPIC_API_KEY (or TRIAGEMESH_MODEL)`);
  return usage.inputTokens + usage.outputTokens;
}

export const HedgingVariantSchema = z.object({
  hedging: z.boolean(),
  runs: z.number().int(),
  top1: z.number(),
  /** Concurrent query phase only (the part hedging affects). */
  meanQueryMs: z.number(),
  p95QueryMs: z.number(),
  /** Worst single run. */
  maxQueryMs: z.number(),
  hedgedSteps: z.number().int(),
  /** Steps that needed more than one attempt without a hedge (timeouts then retries). */
  retriedSteps: z.number().int(),
});
export type HedgingVariant = z.infer<typeof HedgingVariantSchema>;

/**
 * What hedging alone buys: the orchestrator over the same incidents, seeds
 * and latency, once with hedging on and once off. Everything else is equal.
 */
export async function runHedgingAblation(options: Pick<BenchOptions, "seeds" | "incidents" | "role">): Promise<HedgingVariant[]> {
  const incidents = options.incidents ?? INCIDENT_IDS;
  const variants: HedgingVariant[] = [];
  for (const hedging of [true, false]) {
    const query: number[] = [];
    let correct = 0;
    let hedgedSteps = 0;
    let retriedSteps = 0;
    for (const incident of incidents) {
      for (const seed of options.seeds) {
        const run = await investigateIncident({
          incident,
          seed,
          role: options.role ?? "responder",
          latency: DEFAULT_SIM_LATENCY,
          ...(!hedging && { executor: { hedgeAfterMs: undefined } }),
        });
        if (!run.ok) throw new Error(`orchestrator failed on ${incident}/${seed}: ${run.error.message}`);
        const { report, world } = run.value;
        const top = report.resolution.hypotheses[0];
        const truth = world.groundTruth;
        if (top && key(top.kind, top.service, top.ref ?? null) === key(truth.kind, truth.service, truth.ref ?? null)) correct++;
        query.push(report.stats.executionMs);
        hedgedSteps += report.execution.steps.filter((st) => st.hedged).length;
        retriedSteps += report.execution.steps.filter((st) => st.attempts > 1 && !st.hedged).length;
      }
    }
    const sorted = [...query].sort((a, b) => a - b);
    variants.push({
      hedging,
      runs: query.length,
      top1: round(correct / Math.max(1, query.length)),
      meanQueryMs: round(query.reduce((t, q) => t + q, 0) / Math.max(1, query.length)),
      p95QueryMs: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0,
      maxQueryMs: sorted.at(-1) ?? 0,
      hedgedSteps,
      retriedSteps,
    });
  }
  return variants;
}

export function renderHedgingMarkdown(variants: readonly HedgingVariant[]): string {
  const s = (x: number) => `${(x / 1000).toFixed(2)}s`;
  return [
    "## Hedging ablation (orchestrator only)",
    "",
    "Same incidents, seeds and latency; only `hedgeAfterMs` differs. Times are the concurrent query phase.",
    "",
    "| hedging | top-1 | mean query time | p95 query time | worst run | hedged steps | timed-out-and-retried steps |",
    "|---|---|---|---|---|---|---|",
    ...variants.map(
      (v) => `| ${v.hedging ? "on" : "off"} | ${Math.round(v.top1 * 100)}% | ${s(v.meanQueryMs)} | ${s(v.p95QueryMs)} | ${s(v.maxQueryMs)} | ${v.hedgedSteps} | ${v.retriedSteps} |`,
    ),
    "",
  ].join("\n");
}

function key(kind: string, service: string, ref: string | null): string {
  return `${kind}:${service}:${ref ?? "-"}`;
}

function record(
  system: System,
  incident: string,
  seed: number,
  ranked: readonly string[],
  truth: GroundTruth,
  stats: { elapsedMs: number; toolCalls: number; llmCalls: number; llmTokens: number; policyDenials: number },
  extra: Pick<RunRecord, "wallMs" | "billedTokens" | "outcome">,
): RunRecord {
  // Correct means the right kind of cause, in the right service, pointing at the right thing.
  const correct = key(truth.kind, truth.service, truth.ref ?? null);
  return {
    system,
    incident,
    seed,
    answer: ranked[0] ?? null,
    top1: ranked[0] === correct,
    top3: ranked.slice(0, 3).includes(correct),
    elapsedMs: stats.elapsedMs,
    toolCalls: stats.toolCalls,
    llmCalls: stats.llmCalls,
    llmTokens: stats.llmTokens,
    ...extra,
    policyDenials: stats.policyDenials,
  };
}

function summarise(system: System, runs: readonly RunRecord[]): Summary {
  const mean = (f: (r: RunRecord) => number) => round(runs.reduce((s, r) => s + f(r), 0) / Math.max(1, runs.length));
  const share = (f: (r: RunRecord) => boolean) => round(runs.filter(f).length / Math.max(1, runs.length));
  const elapsed = runs.map((r) => r.elapsedMs).sort((a, b) => a - b);
  // Only meaningful when every run has the value (real-model runs).
  const meanOf = (f: (r: RunRecord) => number | null) => (runs.length > 0 && runs.every((r) => f(r) !== null) ? mean((r) => f(r) ?? 0) : null);
  return {
    system,
    runs: runs.length,
    top1: share((r) => r.top1),
    top3: share((r) => r.top3),
    meanElapsedMs: mean((r) => r.elapsedMs),
    p95ElapsedMs: elapsed[Math.min(elapsed.length - 1, Math.ceil(0.95 * elapsed.length) - 1)] ?? 0,
    meanToolCalls: mean((r) => r.toolCalls),
    meanLlmCalls: mean((r) => r.llmCalls),
    meanLlmTokens: mean((r) => r.llmTokens),
    meanBilledTokens: meanOf((r) => r.billedTokens),
    meanWallMs: meanOf((r) => r.wallMs),
    policyDenials: runs.reduce((s, r) => s + r.policyDenials, 0),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Markdown for bench/results and the README. Deterministic: no timestamps. */
export function renderMarkdown(result: BenchResult): string {
  const s = (x: number) => `${(x / 1000).toFixed(1)}s`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const real = result.config.llm !== "mock";
  const out: string[] = [
    "# Benchmark: orchestrator vs sequential ReAct baseline",
    "",
    `${result.config.incidents.length} incidents x seeds [${result.config.seeds.join(", ")}], role \`${result.config.role}\`, LLM \`${result.config.llm}\`. ` +
      (real
        ? "Real model: \"real time\" includes model latency; \"sim time\" covers simulated tool latency only. Not deterministic."
        : "Mock LLM, simulated tool and LLM latency on a virtual clock (exact and reproducible)."),
    "",
    real
      ? "| system | top-1 | top-3 | real time | sim time | tool calls | LLM calls | billed tokens | policy denials |"
      : "| system | top-1 | top-3 | mean time | p95 time | tool calls | LLM calls | est. tokens | policy denials |",
    "|---|---|---|---|---|---|---|---|---|",
    ...result.summary.map((r) =>
      real
        ? `| ${r.system} | ${pct(r.top1)} | ${pct(r.top3)} | ${s(r.meanWallMs ?? 0)} | ${s(r.meanElapsedMs)} | ${r.meanToolCalls} | ${r.meanLlmCalls} | ${Math.round(r.meanBilledTokens ?? 0)} | ${r.policyDenials} |`
        : `| ${r.system} | ${pct(r.top1)} | ${pct(r.top3)} | ${s(r.meanElapsedMs)} | ${s(r.p95ElapsedMs)} | ${r.meanToolCalls} | ${r.meanLlmCalls} | ${Math.round(r.meanLlmTokens)} | ${r.policyDenials} |`,
    ),
    "",
    "## Per incident",
    "",
    "| incident | orchestrator top-1 | baseline top-1 | orchestrator time | baseline time | orchestrator's answer | baseline's answer |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const incident of result.config.incidents) {
    const of = (system: System) => result.runs.filter((r) => r.incident === incident && r.system === system);
    const o = of("orchestrator");
    const b = of("baseline");
    const acc = (rs: RunRecord[]) => pct(rs.filter((r) => r.top1).length / Math.max(1, rs.length));
    const meanTime = (rs: RunRecord[]) => s(rs.reduce((t, r) => t + (real ? (r.wallMs ?? 0) : r.elapsedMs), 0) / Math.max(1, rs.length));
    const verdict = (rs: RunRecord[]) => {
      const wrong = [...new Set(rs.filter((r) => !r.top1).map((r) => r.answer ?? "none"))];
      return wrong.length ? `wrong: \`${wrong.join("`, `")}\`` : "correct";
    };
    out.push(`| ${incident} | ${acc(o)} | ${acc(b)} | ${meanTime(o)} | ${meanTime(b)} | ${verdict(o)} | ${verdict(b)} |`);
  }
  return out.join("\n") + "\n";
}
