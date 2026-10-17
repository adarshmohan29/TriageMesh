import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { MockLlm, type MockResponder, type MockResponders } from "../../src/llm/mock.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { levels } from "../../src/planner/dag.js";
import { mockPlannerResponder } from "../../src/planner/mock.js";
import { MAX_STEPS } from "../../src/planner/plan.js";
import { Planner } from "../../src/planner/planner.js";
import { suspectServices, templateNeeds } from "../../src/planner/template.js";
import { mockRouterResponder } from "../../src/router/mock.js";
import { Router } from "../../src/router/router.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { createSimRegistry } from "../../src/tools/index.js";
import { invoke } from "../tools/helpers.js";
import { defaultPolicy, makeInvoker } from "../policy/helpers.js";
import { makeWorld } from "../sim/helpers.js";

function makePlanner(incident: string, planner?: MockResponder) {
  const { world } = makeWorld(incident);
  const registry = createSimRegistry(world);
  const policy = new PolicyEngine(defaultPolicy());
  const responders: MockResponders = { "router.pick": mockRouterResponder, ...(planner && { "planner.plan": planner }) };
  const llm = new MockLlm(responders);
  return { world, llm, planner: new Planner({ registry, policy, llm, router: new Router({ registry, policy, llm }) }) };
}

/** A draft step, as the LLM would write it. */
function draftStep(id: string, tool: string, input: unknown, dependsOn: string[] = []) {
  return { id, tool, input: JSON.stringify(input), dependsOn, purpose: "test" };
}

describe("suspectServices", () => {
  it("includes the alerting service and everything downstream", () => {
    expect(suspectServices({ service: "api" })).toEqual(["api", "payments", "database"]);
  });

  // flag-retry-storm: payments' retries overload the database.
  it("includes the direct caller, since callers drive load", () => {
    expect(suspectServices({ service: "database" })).toEqual(["payments", "database"]);
  });
});

describe("template plan", () => {
  it("is used when the LLM is unavailable", async () => {
    const { world, planner } = makePlanner("bad-deploy");
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(plan.source).toBe("template");
    expect(plan.notes.at(-1)).toMatch(/LLM unavailable/);
  });

  it("covers changes, the alert metric and logs for every suspect service", async () => {
    // Alerts on api, so all three services are suspects.
    const { world, planner } = makePlanner("disk-full-injection");
    const ids = unwrap(await planner.plan(world.alert, { role: "investigator" })).steps.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["status", "deploys", "flags", "config", "metric-api-error_rate", "logs-api", "logs-payments", "logs-database"]));
  });

  it("does not duplicate the alert metric", () => {
    const { world } = makeWorld("bad-deploy");
    const ids = templateNeeds(world.alert).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks back far enough to see memory-leak's deploy", async () => {
    const { world, planner } = makePlanner("memory-leak");
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    const deploysStep = plan.steps.find((s) => s.id === "deploys");
    const out = unwrap(await invoke(world, "deploys.list", deploysStep?.input));
    expect(out.deploys.map((d: { service: string }) => d.service)).toContain("api");
  });

  it("is a single parallel level", async () => {
    const { world, planner } = makePlanner("bad-deploy");
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(levels(plan.steps)).toHaveLength(1);
  });

  it.each(INCIDENTS.map((i) => [i.id]))("stays within the step limit for %s", async (id) => {
    const { world, planner } = makePlanner(id);
    expect(unwrap(await planner.plan(world.alert, { role: "investigator" })).steps.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("returns no_plan for a role with no tools", async () => {
    const { world, planner } = makePlanner("bad-deploy");
    expect(await planner.plan(world.alert, { role: "nobody" })).toMatchObject({ ok: false, error: { code: "no_plan" } });
  });
});

describe("LLM plan", () => {
  it("is accepted when valid and topped up with missing core steps", async () => {
    const { world, planner } = makePlanner("bad-deploy", mockPlannerResponder);
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(plan.source).toBe("llm");
    expect(plan.steps.map((s) => s.id)).toContain("status");
    expect(plan.notes).toContain('added core step "status" missing from the LLM plan');
  });

  it("does not add a core step the LLM already planned under another id", async () => {
    const { world, planner } = makePlanner("bad-deploy", () => ({ steps: [draftStep("whats-running", "service.status", {})] }));
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(plan.steps.filter((s) => s.tool === "service.status")).toHaveLength(1);
  });

  it("keeps the LLM's dependencies", async () => {
    const draft = { steps: [draftStep("a", "deploys.list", {}), draftStep("b", "logs.search", { service: "payments" }, ["a"])] };
    const { world, planner } = makePlanner("bad-deploy", () => draft);
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(plan.steps.find((s) => s.id === "b")?.dependsOn).toEqual(["a"]);
  });

  const rejected: [string, unknown, RegExp][] = [
    ["a write tool", { steps: [draftStep("fix", "deploy.rollback", { service: "payments" })] }, /plans may only read/],
    ["an unknown tool", { steps: [draftStep("x", "shell.exec", { cmd: "ls" })] }, /unknown tool "shell.exec"/],
    ["input that fails the tool schema", { steps: [draftStep("m", "metrics.query", { service: "mainframe" })] }, /invalid input for metrics.query/],
    ["input that is not JSON", { steps: [{ ...draftStep("m", "flags.list", {}), input: "{oops" }] }, /not valid JSON/],
    ["a cycle", { steps: [draftStep("a", "flags.list", {}, ["b"]), draftStep("b", "deploys.list", {}, ["a"])] }, /cycle/],
    ["a reply that is not a plan", { plan: "check the logs" }, /invalid_output/],
  ];

  it.each(rejected)("falls back to the template for %s", async (_name, draft, reason) => {
    const { world, planner } = makePlanner("bad-deploy", () => draft);
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    expect(plan.source).toBe("template");
    expect(plan.notes.at(-1)).toMatch(reason);
  });

  it("sends the alert and the tool list as data blocks, never in the instruction", async () => {
    const { world, planner, llm } = makePlanner("bad-deploy", mockPlannerResponder);
    await planner.plan(world.alert, { role: "investigator" });
    const call = llm.calls.find((c) => c.purpose === "planner.plan");
    expect(call?.data.map((d) => d.label)).toEqual(["alert", "tools"]);
    expect(call?.instruction).not.toContain(world.alert.title);
  });

  it("offers the LLM read tools only", async () => {
    const { world, planner, llm } = makePlanner("bad-deploy", mockPlannerResponder);
    await planner.plan(world.alert, { role: "incident_commander" });
    const tools = llm.calls.find((c) => c.purpose === "planner.plan")?.data.find((d) => d.label === "tools")?.content as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain("db.failover");
  });
});

describe("plans against the real invoker", () => {
  it.each(INCIDENTS.map((i) => [i.id]))("every step of the %s plan succeeds as investigator", async (id) => {
    const { world, planner } = makePlanner(id, mockPlannerResponder);
    const plan = unwrap(await planner.plan(world.alert, { role: "investigator" }));
    const { invoker } = makeInvoker(id);
    const failures: string[] = [];
    for (const step of plan.steps) {
      const result = await invoker.invoke(step.tool, step.input, { role: "investigator" });
      if (!result.ok) failures.push(`${step.id}: ${result.error.message}`);
    }
    expect(failures).toEqual([]);
  });
});
