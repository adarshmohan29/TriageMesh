import { z } from "zod";
import { baselineIncident } from "../baseline/sim.js";
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

  for (const incident of incidents) {
    for (const seed of options.seeds) {
      const orchestrated = await investigateIncident({ incident, seed, role, latency });
      if (!orchestrated.ok) throw new Error(`orchestrator failed on ${incident}/${seed}: ${orchestrated.error.message}`);
      const { report, world } = orchestrated.value;
      const ranked = report.resolution.hypotheses.map((h) => key(h.kind, h.service, h.ref ?? null));
      runs.push(record("orchestrator", incident, seed, ranked, world.groundTruth, report.stats));

      const baseline = await baselineIncident({ incident, seed, role, latency });
      if (!baseline.ok) throw new Error(`baseline failed on ${incident}/${seed}: ${baseline.error.message}`);
      const answers = baseline.value.report.answer.map((a) => key(a.kind, a.service, a.ref));
      runs.push(record("baseline", incident, seed, answers, baseline.value.world.groundTruth, baseline.value.report.stats));
    }
  }

  return {
    config: { seeds: options.seeds, incidents: [...incidents], role, llm: "mock", latency },
    summary: SYSTEMS.map((system) => summarise(system, runs.filter((r) => r.system === system))),
    runs,
  };
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
    policyDenials: stats.policyDenials,
  };
}

function summarise(system: System, runs: readonly RunRecord[]): Summary {
  const mean = (f: (r: RunRecord) => number) => round(runs.reduce((s, r) => s + f(r), 0) / Math.max(1, runs.length));
  const share = (f: (r: RunRecord) => boolean) => round(runs.filter(f).length / Math.max(1, runs.length));
  const elapsed = runs.map((r) => r.elapsedMs).sort((a, b) => a - b);
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
  const out: string[] = [
    "# Benchmark: orchestrator vs sequential ReAct baseline",
    "",
    `${result.config.incidents.length} incidents x seeds [${result.config.seeds.join(", ")}], role \`${result.config.role}\`, ` +
      "mock LLM, simulated tool and LLM latency on a virtual clock (exact and reproducible).",
    "",
    "| system | top-1 | top-3 | mean time | p95 time | tool calls | LLM calls | est. tokens | policy denials |",
    "|---|---|---|---|---|---|---|---|---|",
    ...result.summary.map(
      (r) =>
        `| ${r.system} | ${pct(r.top1)} | ${pct(r.top3)} | ${s(r.meanElapsedMs)} | ${s(r.p95ElapsedMs)} | ${r.meanToolCalls} | ${r.meanLlmCalls} | ${Math.round(r.meanLlmTokens)} | ${r.policyDenials} |`,
    ),
    "",
    "## Per incident",
    "",
    "| incident | orchestrator top-1 | baseline top-1 | orchestrator time | baseline time | baseline's answer |",
    "|---|---|---|---|---|---|",
  ];
  for (const incident of result.config.incidents) {
    const of = (system: System) => result.runs.filter((r) => r.incident === incident && r.system === system);
    const o = of("orchestrator");
    const b = of("baseline");
    const acc = (rs: RunRecord[]) => pct(rs.filter((r) => r.top1).length / Math.max(1, rs.length));
    const meanTime = (rs: RunRecord[]) => s(rs.reduce((t, r) => t + r.elapsedMs, 0) / Math.max(1, rs.length));
    const wrong = [...new Set(b.filter((r) => !r.top1).map((r) => r.answer ?? "none"))];
    out.push(`| ${incident} | ${acc(o)} | ${acc(b)} | ${meanTime(o)} | ${meanTime(b)} | ${wrong.length ? `wrong: \`${wrong.join("`, `")}\`` : "correct"} |`);
  }
  return out.join("\n") + "\n";
}
