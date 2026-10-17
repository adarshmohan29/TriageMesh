import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VirtualClock } from "../../src/core/clock.js";
import { err, ok, unwrap } from "../../src/core/result.js";
import { createRng } from "../../src/core/rng.js";
import { Executor, type ExecutorConfig, type ExecutionResult } from "../../src/executor/executor.js";
import { denyAll } from "../../src/policy/approval.js";
import { AuditLog } from "../../src/policy/audit.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { GuardedInvoker } from "../../src/policy/invoker.js";
import type { Plan, Step } from "../../src/planner/plan.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { defineTool } from "../../src/registry/tool.js";
import { defaultPolicy } from "../policy/helpers.js";

const NO_HEDGE: Partial<ExecutorConfig> = { hedgeAfterMs: undefined };

/**
 * Test tools with scripted behaviour, keyed by `key` so each step has its own
 * script. test.slow call n sleeps delays[n] (last value repeats); test.flaky
 * fails its first `failures` calls.
 */
function harness(config: Partial<ExecutorConfig> = {}) {
  const clock = new VirtualClock(0);
  const calls = new Map<string, number>();
  const aborted: string[] = [];
  let active = 0;
  let maxActive = 0;
  const nextCall = (key: string) => {
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    return n;
  };

  const slow = defineTool({
    name: "test.slow",
    description: "sleeps for a scripted time",
    capabilities: ["logs.read"],
    tier: "read",
    inputSchema: z.object({ key: z.string(), delays: z.array(z.number()).default([0]) }),
    outputSchema: z.object({ key: z.string(), call: z.number() }),
    async run({ key, delays }, ctx) {
      const n = nextCall(key);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await clock.sleep(delays[Math.min(n, delays.length - 1)] ?? 0, ctx.signal);
        return ok({ key, call: n });
      } catch {
        aborted.push(`${key}#${n}`);
        return err({ code: "aborted", message: "aborted" });
      } finally {
        active--;
      }
    },
  });

  const flaky = defineTool({
    name: "test.flaky",
    description: "fails a scripted number of times",
    capabilities: ["logs.read"],
    tier: "read",
    inputSchema: z.object({ key: z.string(), failures: z.number() }),
    outputSchema: z.object({ call: z.number() }),
    async run({ key, failures }) {
      const n = nextCall(key);
      return n < failures ? err({ code: "failed", message: `failure ${n + 1}` }) : ok({ call: n });
    },
  });

  const flakyWrite = defineTool({
    name: "test.flaky_write",
    description: "a write that always fails",
    capabilities: ["service.write"],
    tier: "reversible_write",
    inputSchema: z.object({ key: z.string() }),
    outputSchema: z.object({}),
    async run({ key }) {
      nextCall(key);
      return err({ code: "failed", message: "write failed" });
    },
    async dryRun() {
      return ok({ summary: "write", changes: [], affectedServices: [] });
    },
  });

  const registry = new ToolRegistry([slow, flaky, flakyWrite]);
  const invoker = new GuardedInvoker({
    registry,
    policy: new PolicyEngine(defaultPolicy()),
    audit: new AuditLog({ clock }),
    approve: denyAll,
  });
  const executor = new Executor({ invoker, registry, clock, rng: createRng(1), config });

  async function run(steps: Step[], role = "investigator", signal?: AbortSignal): Promise<ExecutionResult> {
    const plan: Plan = { alertId: "a", source: "template", notes: [], steps };
    const pending = executor.execute(plan, signal ? { role, signal } : { role });
    await clock.runAll();
    return unwrap(await pending);
  }

  return { clock, run, calls, aborted, maxActive: () => maxActive };
}

function step(id: string, tool: string, input: Record<string, unknown>, dependsOn: string[] = []): Step {
  return { id, tool, input: { key: id, ...input }, dependsOn, purpose: "test" };
}

const byId = (result: ExecutionResult, id: string) => result.steps.find((s) => s.stepId === id);

describe("Executor scheduling", () => {
  it("returns results in plan order regardless of finish order", async () => {
    const { run } = harness(NO_HEDGE);
    const result = await run([step("slow", "test.slow", { delays: [500] }), step("fast", "test.slow", { delays: [10] })]);
    expect(result.steps.map((s) => s.stepId)).toEqual(["slow", "fast"]);
    expect(result.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("never runs more steps at once than the concurrency limit", async () => {
    const { run, maxActive } = harness({ ...NO_HEDGE, concurrency: 2 });
    const steps = ["a", "b", "c", "d", "e", "f"].map((id) => step(id, "test.slow", { delays: [1_000] }));
    const result = await run(steps);
    expect(maxActive()).toBe(2);
    expect(result.finishedAt - result.startedAt).toBe(3_000);
  });

  it("runs independent steps in parallel", async () => {
    const { run } = harness({ ...NO_HEDGE, concurrency: 4 });
    const result = await run(["a", "b", "c"].map((id) => step(id, "test.slow", { delays: [1_000] })));
    expect(result.finishedAt - result.startedAt).toBe(1_000);
  });

  it("starts a step only after its dependencies finish", async () => {
    const { run } = harness(NO_HEDGE);
    const result = await run([step("b", "test.slow", { delays: [10] }, ["a"]), step("a", "test.slow", { delays: [700] })]);
    expect(byId(result, "b")?.startedAt).toBeGreaterThanOrEqual(byId(result, "a")?.finishedAt ?? Infinity);
  });

  it("skips dependents of a failed step but runs independent ones", async () => {
    const { run } = harness({ ...NO_HEDGE, retries: 0 });
    const result = await run([
      step("bad", "test.flaky", { failures: 9 }),
      step("child", "test.slow", {}, ["bad"]),
      step("grandchild", "test.slow", {}, ["child"]),
      step("other", "test.slow", {}),
    ]);
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "skipped", "skipped", "ok"]);
    expect(byId(result, "child")?.error?.code).toBe("dependency_failed");
  });

  it("rejects a plan with a cycle", async () => {
    const { clock } = harness();
    const registry = new ToolRegistry();
    const executor = new Executor({ invoker: { invoke: async () => err({ code: "unknown_tool", tool: "x", message: "" }) }, registry, clock, rng: createRng(1) });
    const plan: Plan = { alertId: "a", source: "template", notes: [], steps: [step("a", "x", {}, ["b"]), step("b", "x", {}, ["a"])] };
    expect(await executor.execute(plan, { role: "investigator" })).toMatchObject({ ok: false });
  });
});

describe("Executor timeouts and retries", () => {
  it("times out a slow attempt and retries it", async () => {
    const { run, aborted } = harness({ ...NO_HEDGE, timeoutMs: 1_000 });
    const result = await run([step("s", "test.slow", { delays: [60_000, 100] })]);
    expect(byId(result, "s")).toMatchObject({ status: "ok", attempts: 2 });
    expect(aborted).toEqual(["s#0"]);
  });

  it("waits a backoff between attempts", async () => {
    const { run } = harness({ ...NO_HEDGE, timeoutMs: 1_000, baseBackoffMs: 200 });
    const s = byId(await run([step("s", "test.slow", { delays: [60_000, 0] })]), "s");
    const elapsed = (s?.finishedAt ?? 0) - (s?.startedAt ?? 0);
    expect(elapsed).toBeGreaterThanOrEqual(1_200);
    expect(elapsed).toBeLessThanOrEqual(1_400);
  });

  it("retries a tool error until it succeeds", async () => {
    const { run } = harness({ ...NO_HEDGE, retries: 2 });
    expect(byId(await run([step("f", "test.flaky", { failures: 2 })]), "f")).toMatchObject({ status: "ok", attempts: 3 });
  });

  it("gives up after the configured retries", async () => {
    const { run } = harness({ ...NO_HEDGE, retries: 2 });
    const f = byId(await run([step("f", "test.flaky", { failures: 9 })]), "f");
    expect(f).toMatchObject({ status: "failed", attempts: 3, error: { code: "tool_error", message: "failure 3" } });
  });

  it("does not retry failures that would fail again", async () => {
    const { run } = harness({ ...NO_HEDGE, retries: 2 });
    const f = byId(await run([step("f", "test.flaky", { failures: "many" })]), "f");
    expect(f).toMatchObject({ status: "failed", attempts: 1, error: { code: "invalid_input" } });
  });

  it("does not retry a policy denial", async () => {
    const { run, calls } = harness({ ...NO_HEDGE, retries: 2 });
    const w = byId(await run([step("w", "test.flaky_write", {})], "investigator"), "w");
    expect(w).toMatchObject({ status: "failed", attempts: 1, error: { code: "denied" } });
    expect(calls.get("w")).toBeUndefined();
  });

  it("never retries a write, even on a retryable error", async () => {
    const { run, calls } = harness({ ...NO_HEDGE, retries: 2 });
    const w = byId(await run([step("w", "test.flaky_write", {})], "responder"), "w");
    expect(w).toMatchObject({ status: "failed", attempts: 1, error: { code: "tool_error" } });
    expect(calls.get("w")).toBe(1);
  });
});

describe("Executor hedging", () => {
  it("starts a duplicate of a slow call and keeps the faster one", async () => {
    const { run, aborted } = harness({ hedgeAfterMs: 1_000, timeoutMs: 10_000 });
    const s = byId(await run([step("s", "test.slow", { delays: [8_000, 100] })]), "s");
    expect(s).toMatchObject({ status: "ok", attempts: 2, hedged: true, output: { call: 1 } });
    expect((s?.finishedAt ?? 0) - (s?.startedAt ?? 0)).toBe(1_100);
    expect(aborted).toEqual(["s#0"]);
  });

  it("keeps the original if it finishes first after all", async () => {
    const { run, aborted } = harness({ hedgeAfterMs: 1_000, timeoutMs: 10_000 });
    const s = byId(await run([step("s", "test.slow", { delays: [1_200, 5_000] })]), "s");
    expect(s).toMatchObject({ status: "ok", hedged: true, output: { call: 0 } });
    expect(aborted).toEqual(["s#1"]);
  });

  it("does not hedge a call that finishes in time", async () => {
    const { run } = harness({ hedgeAfterMs: 1_000 });
    expect(byId(await run([step("s", "test.slow", { delays: [300] })]), "s")).toMatchObject({ hedged: false, attempts: 1 });
  });

  it("never hedges a write", async () => {
    const { run, calls } = harness({ hedgeAfterMs: 0, retries: 0 });
    await run([step("w", "test.flaky_write", {})], "responder");
    expect(calls.get("w")).toBe(1);
  });
});

describe("Executor abort and determinism", () => {
  it("aborts the running step and never starts queued ones", async () => {
    const { run, clock, aborted, calls } = harness({ ...NO_HEDGE, concurrency: 1, timeoutMs: 10_000 });
    const controller = new AbortController();
    void clock.sleep(500).then(() => controller.abort(new Error("operator cancelled")));
    const result = await run(
      [step("running", "test.slow", { delays: [5_000] }), step("queued", "test.slow", { delays: [5_000] })],
      "investigator",
      controller.signal,
    );
    expect(result.steps.map((s) => [s.status, s.error?.code])).toEqual([
      ["failed", "aborted"],
      ["failed", "aborted"],
    ]);
    expect(aborted).toEqual(["running#0"]);
    expect(calls.get("queued")).toBeUndefined();
    expect(result.finishedAt).toBe(500);
  });

  it("produces identical timings for the same seed", async () => {
    const steps = [step("s", "test.slow", { delays: [60_000, 60_000, 0] }), step("f", "test.flaky", { failures: 2 })];
    const a = await harness({ timeoutMs: 1_000 }).run(steps);
    const b = await harness({ timeoutMs: 1_000 }).run(steps);
    expect(a).toEqual(b);
  });
});
