import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VirtualClock } from "../../src/core/clock.js";
import { estimateTokens, MeteredLlm } from "../../src/llm/metered.js";
import { MockLlm } from "../../src/llm/mock.js";

const request = { purpose: "router.pick" as const, instruction: "pick a tool", data: [{ label: "x", content: [1, 2, 3] }], schema: z.object({ tool: z.string() }) };

describe("MeteredLlm", () => {
  it("counts calls and estimates tokens in and out", async () => {
    const llm = new MeteredLlm(new MockLlm({ "router.pick": () => ({ tool: "logs.search" }) }));
    await llm.generate(request);
    await llm.generate(request);
    expect(llm.usage.calls).toBe(2);
    expect(llm.usage.inputTokens).toBe(2 * estimateTokens(request.instruction + JSON.stringify(request.data)));
    expect(llm.usage.outputTokens).toBe(2 * estimateTokens('{"tool":"logs.search"}'));
  });

  it("counts failed calls but no output tokens", async () => {
    const llm = new MeteredLlm(new MockLlm());
    expect((await llm.generate(request)).ok).toBe(false);
    expect(llm.usage).toMatchObject({ calls: 1, outputTokens: 0 });
  });

  it("adds simulated latency on the clock", async () => {
    const clock = new VirtualClock(0);
    const llm = new MeteredLlm(new MockLlm({ "router.pick": () => ({ tool: "x" }) }), { clock, latencyMs: 1_000 });
    const pending = llm.generate(request);
    await clock.runAll();
    await pending;
    expect(clock.now()).toBe(1_000);
  });

  it("keeps the inner client's name", () => {
    expect(new MeteredLlm(new MockLlm()).name).toBe("mock");
  });
});
