import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm } from "../../src/llm/factory.js";
import { MockLlm } from "../../src/llm/mock.js";

const schema = z.object({ tool: z.string() });
const request = { purpose: "router.pick" as const, instruction: "pick", data: [], schema };

describe("MockLlm", () => {
  it("returns a responder's reply after validating it", async () => {
    const llm = new MockLlm({ "router.pick": () => ({ tool: "logs.search" }) });
    expect(await llm.generate(request)).toEqual({ ok: true, value: { tool: "logs.search" } });
  });

  it("reports invalid_output when a reply fails the schema", async () => {
    const llm = new MockLlm({ "router.pick": () => ({ tool: 42 }) });
    expect(await llm.generate(request)).toMatchObject({ ok: false, error: { code: "invalid_output" } });
  });

  it("reports unavailable for a purpose with no responder", async () => {
    expect(await new MockLlm().generate(request)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("reports aborted when the signal is already aborted", async () => {
    const llm = new MockLlm({ "router.pick": () => ({ tool: "x" }) });
    expect(await llm.generate(request, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("records every request", async () => {
    const llm = new MockLlm();
    await llm.generate(request);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["router.pick"]);
  });
});

describe("createLlm", () => {
  it("defaults to the mock", () => {
    const result = createLlm({});
    expect(result.ok && result.value.name).toBe("mock");
  });

  it("builds the Anthropic client with the model override", () => {
    const result = createLlm({ TRIAGEMESH_LLM: "anthropic", TRIAGEMESH_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "test" });
    expect(result.ok && result.value.name).toBe("anthropic:claude-sonnet-5-5");
  });

  it("rejects an unknown mode", () => {
    expect(createLlm({ TRIAGEMESH_LLM: "gpt" }).ok).toBe(false);
  });
});
