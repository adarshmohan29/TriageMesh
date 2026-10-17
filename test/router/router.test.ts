import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { MockLlm, type MockResponders } from "../../src/llm/mock.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { mockRouterResponder } from "../../src/router/mock.js";
import { Router } from "../../src/router/router.js";
import { createSimRegistry } from "../../src/tools/index.js";
import { defaultPolicy } from "../policy/helpers.js";
import { makeWorld } from "../sim/helpers.js";

function makeRouter(responders: MockResponders = { "router.pick": mockRouterResponder }) {
  const { world } = makeWorld("pool-exhaustion");
  const llm = new MockLlm(responders);
  const router = new Router({ registry: createSimRegistry(world), policy: new PolicyEngine(defaultPolicy()), llm });
  return { router, llm };
}

describe("Router.shortlist", () => {
  it("only offers tools within the role's tiers", () => {
    const { router } = makeRouter();
    expect(router.shortlist("db.write", "responder").map((s) => s.name)).toEqual(["db.pool.resize"]);
  });

  it("drops tools that a policy rule denies outright", () => {
    const { router } = makeRouter();
    expect(router.shortlist("db.write", "incident_commander").map((s) => s.name)).not.toContain("db.drop_table");
  });

  it("lists least-privileged tools first", () => {
    const { router } = makeRouter();
    expect(router.shortlist("db.write", "incident_commander").map((s) => s.tier)).toEqual(["reversible_write", "destructive"]);
  });
});

describe("Router.route", () => {
  it("skips the LLM when there is a single candidate", async () => {
    const { router, llm } = makeRouter();
    const route = unwrap(await router.route({ capability: "logs.read", role: "investigator", goal: "find errors" }));
    expect(route).toMatchObject({ tool: "logs.search", via: "single" });
    expect(llm.calls).toEqual([]);
  });

  it("lets the LLM choose between several candidates", async () => {
    const { router } = makeRouter();
    const route = unwrap(await router.route({ capability: "db.write", role: "incident_commander", goal: "promote a replica to primary" }));
    expect(route).toMatchObject({ tool: "db.failover", via: "llm" });
  });

  it("passes the goal and shortlist to the LLM as data blocks", async () => {
    const { router, llm } = makeRouter();
    await router.route({ capability: "db.write", role: "incident_commander", goal: "resize the pool" });
    expect(llm.calls[0]?.data.map((d) => d.label)).toEqual(["request", "shortlist"]);
  });

  it("falls back to the least-privileged tool when the LLM picks off the shortlist", async () => {
    const { router } = makeRouter({ "router.pick": () => ({ tool: "db.drop_table", reason: "free disk space" }) });
    const route = unwrap(await router.route({ capability: "db.write", role: "incident_commander", goal: "disk full" }));
    expect(route).toMatchObject({ tool: "db.pool.resize", via: "fallback", reason: expect.stringMatching(/not on the shortlist/) });
  });

  it("falls back when the LLM reply is malformed", async () => {
    const { router } = makeRouter({ "router.pick": () => "db.failover please" });
    const route = unwrap(await router.route({ capability: "db.write", role: "incident_commander", goal: "x" }));
    expect(route).toMatchObject({ tool: "db.pool.resize", via: "fallback", reason: expect.stringMatching(/invalid_output/) });
  });

  it("falls back when the LLM is unavailable", async () => {
    const { router } = makeRouter({});
    const route = unwrap(await router.route({ capability: "db.write", role: "incident_commander", goal: "x" }));
    expect(route.via).toBe("fallback");
  });

  it("returns no_tool when the role has nothing for the capability", async () => {
    const { router } = makeRouter();
    const result = await router.route({ capability: "db.write", role: "investigator", goal: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "no_tool" } });
  });
});
