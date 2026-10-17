import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { renderHedgingMarkdown, renderMarkdown, runBenchmark, runHedgingAblation, type BenchOptions } from "../bench/bench.js";
import { createLlm } from "../llm/factory.js";
import { DEFAULT_SIM_LATENCY } from "../orchestrator/sim.js";
import { INCIDENT_IDS } from "../sim/incidents/index.js";

const USAGE = `Usage: npm run bench -- [--seeds 5] [--llm mock|anthropic] [--incidents a,b] [--out dir] [--json]

  --seeds <n>        run each incident with seeds 1..n (default 5 for mock, 1 for anthropic)
  --llm <mode>       mock (default, offline, deterministic) or anthropic (real model,
                     needs ANTHROPIC_API_KEY; model from TRIAGEMESH_MODEL; costs money)
  --incidents <ids>  comma-separated subset (default: all 8)
  --out <dir>        default bench/results (mock) or bench/results/anthropic
  --json             print JSON instead of the Markdown table`;

/** `npm run bench`: orchestrator vs ReAct baseline over every incident. */
async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        seeds: { type: "string" },
        llm: { type: "string", default: "mock" },
        incidents: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const real = values.llm !== "mock";
  const n = Number(values.seeds ?? (real ? "1" : "5"));
  if (!Number.isSafeInteger(n) || n < 1) {
    process.stderr.write("--seeds must be a positive integer\n");
    return 2;
  }
  const incidents = values.incidents?.split(",").map((s) => s.trim()) ?? INCIDENT_IDS;
  const unknown = incidents.filter((id) => !INCIDENT_IDS.includes(id));
  if (unknown.length > 0) {
    process.stderr.write(`unknown incident(s): ${unknown.join(", ")}\n`);
    return 2;
  }

  const options: BenchOptions = { seeds: Array.from({ length: n }, (_, i) => i + 1), incidents };
  if (real) {
    // Fail fast on a bad mode before spending anything; then one fresh client per run.
    const probe = createLlm({ ...process.env, TRIAGEMESH_LLM: values.llm });
    if (!probe.ok) {
      process.stderr.write(`${probe.error}\n`);
      return 2;
    }
    options.makeLlm = () => {
      const llm = createLlm({ ...process.env, TRIAGEMESH_LLM: values.llm });
      if (!llm.ok) throw new Error(llm.error);
      return llm.value;
    };
    // Real model latency is real time, so no simulated LLM delay; tools stay simulated.
    options.latency = { ...DEFAULT_SIM_LATENCY, llmMs: 0 };
    options.wallClock = () => performance.now();
    process.stderr.write(
      `Real-model benchmark with ${probe.value.name}: ${incidents.length} incident(s) x ${n} seed(s) x 2 systems.\n` +
        "Expect roughly 4-8 model calls per orchestrator run and 4-12 per baseline run; this uses API credits.\n",
    );
  }

  let result;
  try {
    result = await runBenchmark(options);
  } catch (e) {
    process.stderr.write(`benchmark aborted: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  // The ablation is deterministic and only meaningful on the virtual clock, so mock runs only.
  const hedging = real ? undefined : await runHedgingAblation({ seeds: options.seeds, incidents });
  const markdown = renderMarkdown(result) + (hedging ? `\n${renderHedgingMarkdown(hedging)}` : "");
  const out = values.out ?? (real ? "bench/results/anthropic" : "bench/results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "results.json"), `${JSON.stringify(hedging ? { ...result, hedging } : result, null, 2)}\n`);
  writeFileSync(join(out, "results.md"), markdown);
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : markdown);
  process.stderr.write(`wrote ${join(out, "results.json")} and results.md\n`);
  return 0;
}

process.exitCode = await main();
