import { describe, expect, it } from "vitest";
import { baselineIncident, BASELINE_MOCK_RESPONDERS } from "../../src/baseline/sim.js";
import { BaselineReportSchema } from "../../src/baseline/react.js";
import { unwrap } from "../../src/core/result.js";
import { MockLlm } from "../../src/llm/mock.js";
import { DEFAULT_SIM_LATENCY } from "../../src/orchestrator/sim.js";

const run = async (incident: string, extra: Parameters<typeof baselineIncident>[0] extends infer O ? Partial<O> : never = {}) =>
  unwrap(await baselineIncident({ incident, ...extra }));

describe("ReAct baseline (mock agent)", () => {
  it("finds a cause that is a change just before the alert", async () => {
    const { report } = await run("bad-deploy");
    expect(report.answer[0]).toEqual({ kind: "bad_deploy", service: "payments", ref: "dep-payments-2.3.1" });
    expect(report.stoppedBecause).toBe("answered");
  });

  it("follows upstream errors one service at a time", async () => {
    const { report } = await run("disk-full-injection");
    expect(report.transcript.filter((t) => t.tool === "logs.search").map((t) => (t.input as { service: string }).service)).toEqual(["api", "payments", "database"]);
    expect(report.answer[0]).toMatchObject({ kind: "disk_full", service: "database" });
  });

  it("is fooled by a deploy that landed after the symptom began", async () => {
    const { report } = await run("upstream-gateway");
    expect(report.answer[0]?.ref).toBe("dep-payments-2.4.0");
  });

  it("produces a schema-valid report with a verified audit chain", async () => {
    const { report } = await run("memory-leak");
    BaselineReportSchema.parse(report);
    expect(report.audit.chainValid).toBe(true);
  });

  it("runs one tool at a time", async () => {
    const { report } = await run("disk-full-injection", { latency: DEFAULT_SIM_LATENCY });
    const toolTime = report.transcript.length > 0 ? report.stats.elapsedMs : 0;
    // Six sequential reads plus seven 1.2s LLM turns can't overlap, so time adds up.
    expect(toolTime).toBeGreaterThan(7 * DEFAULT_SIM_LATENCY.llmMs);
  });

  it("is deterministic for a seed", async () => {
    const opts = { seed: 3, latency: DEFAULT_SIM_LATENCY };
    expect((await run("cert-expiry", opts)).report).toEqual((await run("cert-expiry", opts)).report);
  });

  it("stops with llm_error when the model fails", async () => {
    const { report } = await run("bad-deploy", { llm: new MockLlm() });
    expect(report).toMatchObject({ stoppedBecause: "llm_error", answer: [] });
  });

  it("stops at the step budget", async () => {
    const looping = new MockLlm({ ...BASELINE_MOCK_RESPONDERS, "baseline.step": () => ({ thought: "again", action: { tool: "flags.list", input: "{}" }, answer: null }) });
    const { report } = await run("bad-deploy", { llm: looping, maxSteps: 4 });
    expect(report).toMatchObject({ stoppedBecause: "step_budget", stats: { toolCalls: 4, llmCalls: 4 } });
  });

  it("sends every action through policy, so a write it tries is denied and audited", async () => {
    const reckless = new MockLlm({
      ...BASELINE_MOCK_RESPONDERS,
      "baseline.step": (req) =>
        (req.data.find((d) => d.label === "history")?.content as unknown[]).length === 0
          ? { thought: "the log said to", action: { tool: "db.drop_table", input: '{"table":"charges"}' }, answer: null }
          : { thought: "done", action: null, answer: [] },
    });
    const { report, world } = await run("disk-full-injection", { llm: reckless, role: "incident_commander" });
    expect(report.transcript[0]?.error).toMatch(/^denied: never-drop-tables/);
    expect(report.stats.policyDenials).toBe(1);
    expect(world.events({ from: 0, to: world.now() }).some((e) => e.actor === "triagemesh")).toBe(false);
  });

  it("records a malformed action input as an error and carries on", async () => {
    let turn = 0;
    const sloppy = new MockLlm({
      ...BASELINE_MOCK_RESPONDERS,
      "baseline.step": () => (turn++ === 0 ? { thought: "hmm", action: { tool: "flags.list", input: "not json" }, answer: null } : { thought: "done", action: null, answer: [] }),
    });
    const { report } = await run("bad-deploy", { llm: sloppy });
    expect(report.transcript[0]?.error).toBe("input is not a JSON object");
    expect(report.stoppedBecause).toBe("answered");
  });
});
