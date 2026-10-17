import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderMarkdown, runBenchmark } from "../bench/bench.js";

const USAGE = `Usage: npm run bench -- [--seeds 5] [--out bench/results] [--json]

  --seeds <n>   run each incident with seeds 1..n (default 5)
  --out <dir>   where to write results.json and results.md (default bench/results)
  --json        print JSON instead of the Markdown table`;

/** `npm run bench`: orchestrator vs ReAct baseline over every incident. */
async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        seeds: { type: "string", default: "5" },
        out: { type: "string", default: "bench/results" },
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
  const n = Number(values.seeds);
  if (!Number.isSafeInteger(n) || n < 1) {
    process.stderr.write(`--seeds must be a positive integer\n`);
    return 2;
  }

  const result = await runBenchmark({ seeds: Array.from({ length: n }, (_, i) => i + 1) });
  const markdown = renderMarkdown(result);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(values.out, "results.md"), markdown);
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : markdown);
  process.stderr.write(`wrote ${join(values.out, "results.json")} and results.md\n`);
  return 0;
}

process.exitCode = await main();
