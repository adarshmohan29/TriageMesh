import { describe, expect, it } from "vitest";
import { BASELINE_MOCK_RESPONDERS } from "../../src/baseline/sim.js";
import { BenchResultSchema, renderHedgingMarkdown, renderMarkdown, runBenchmark, runHedgingAblation, type BenchResult } from "../../src/bench/bench.js";
import { err } from "../../src/core/result.js";
import type { LlmClient, LlmRequest } from "../../src/llm/client.js";
import { MockLlm } from "../../src/llm/mock.js";

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

describe("benchmark with a real-model client", () => {
  /** Stands in for AnthropicLlm offline: answers with the mocks and reports usage like the API does. */
  class FakeRealLlm implements LlmClient {
    readonly name = "fake-real";
    readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
    readonly #inner = new MockLlm(BASELINE_MOCK_RESPONDERS);
    constructor(readonly answers = true) {}
    async generate<T>(request: LlmRequest<T>) {
      if (!this.answers) return err({ code: "unavailable" as const, message: "no key" });
      this.usage.calls++;
      this.usage.inputTokens += 100;
      this.usage.outputTokens += 10;
      return this.#inner.generate(request);
    }
  }

  it("records billed tokens and wall time from the client and clock it is given", async () => {
    let now = 0;
    const result = await runBenchmark({ seeds: [1], incidents: ["bad-deploy"], makeLlm: () => new FakeRealLlm(), wallClock: () => (now += 500) });
    expect(result.config.llm).toBe("fake-real");
    for (const run of result.runs) {
      expect(run.wallMs).toBe(500);
      expect(run.billedTokens).toBe(run.llmCalls * 110);
    }
    expect(renderMarkdown(result)).toContain("| system | top-1 | top-3 | real time |");
  });

  it("refuses to report a run where the model answered nothing", async () => {
    await expect(runBenchmark({ seeds: [1], incidents: ["bad-deploy"], makeLlm: () => new FakeRealLlm(false) })).rejects.toThrow(/answered no requests/);
  });

  it("leaves real-only fields empty in mock runs", async () => {
    const [summary] = (await bench()).summary;
    expect(summary).toMatchObject({ meanBilledTokens: null, meanWallMs: null });
  });
});

describe("hedging ablation", () => {
  let ablation: ReturnType<typeof runHedgingAblation> | undefined;
  const variants = () => (ablation ??= runHedgingAblation({ seeds: [1, 2, 3] }));

  it("is deterministic", async () => {
    expect(await runHedgingAblation({ seeds: [1, 2, 3] })).toEqual(await variants());
  });

  it("hedges only when hedging is on, without changing accuracy", async () => {
    const [on, off] = await variants();
    expect(on?.hedgedSteps).toBeGreaterThan(0);
    expect(off?.hedgedSteps).toBe(0);
    expect(on?.top1).toBe(off?.top1);
  });

  it("makes the query phase faster on average and in the tail", async () => {
    const [on, off] = await variants();
    expect(on?.meanQueryMs).toBeLessThan(off?.meanQueryMs ?? 0);
    expect(on?.p95QueryMs).toBeLessThan(off?.p95QueryMs ?? 0);
  });

  it("renders a table", async () => {
    expect(renderHedgingMarkdown(await variants())).toContain("| on | 100% |");
  });
});
