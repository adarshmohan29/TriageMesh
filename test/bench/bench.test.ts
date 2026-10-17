import { describe, expect, it } from "vitest";
import { BenchResultSchema, renderMarkdown, runBenchmark, type BenchResult } from "../../src/bench/bench.js";

let cached: Promise<BenchResult> | undefined;
const bench = () => (cached ??= runBenchmark({ seeds: [1, 2] }));
const summary = async (system: "orchestrator" | "baseline") => (await bench()).summary.find((s) => s.system === system);

describe("benchmark", () => {
  it("is identical across runs with the same seeds", async () => {
    expect(await runBenchmark({ seeds: [1, 2] })).toEqual(await bench());
  });

  it("produces a schema-valid result covering every incident x seed x system", async () => {
    const result = BenchResultSchema.parse(await bench());
    expect(result.runs).toHaveLength(8 * 2 * 2);
  });

  it("orchestrator is at least as accurate as the baseline", async () => {
    expect((await summary("orchestrator"))?.top1).toBeGreaterThanOrEqual((await summary("baseline"))?.top1 ?? 1);
  });

  it("orchestrator is faster on average and at the tail", async () => {
    const [o, b] = [await summary("orchestrator"), await summary("baseline")];
    expect(o?.meanElapsedMs).toBeLessThan(b?.meanElapsedMs ?? 0);
    expect(o?.p95ElapsedMs).toBeLessThan(b?.p95ElapsedMs ?? 0);
  });

  it("renders a Markdown summary table", async () => {
    const md = renderMarkdown(await bench());
    expect(md).toContain("| system | top-1 |");
    expect(md).toMatch(/\| upstream-gateway \| 100% \| 0% \|/);
  });
});
