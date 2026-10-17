import { describe, expect, it } from "vitest";
import { PolicyEngine, matchesPattern } from "../../src/policy/engine.js";
import type { Policy } from "../../src/policy/policy.js";
import type { DryRun } from "../../src/registry/tool.js";
import { defaultPolicy } from "./helpers.js";

const engine = new PolicyEngine(defaultPolicy());
const read = { name: "logs.search", tier: "read" } as const;
const flags = { name: "flags.set", tier: "reversible_write" } as const;
const failover = { name: "db.failover", tier: "destructive" } as const;
const dropTable = { name: "db.drop_table", tier: "destructive" } as const;
const poolResize = { name: "db.pool.resize", tier: "reversible_write" } as const;

function preview(services: string[]): DryRun {
  return { summary: "x", changes: [], affectedServices: services };
}

describe("PolicyEngine.checkCall", () => {
  it("denies an unknown role", () => {
    expect(engine.checkCall({ tool: read, role: "intern" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/unknown role/) });
  });

  it("denies a tier the role does not have", () => {
    expect(engine.checkCall({ tool: flags, role: "investigator" })).toMatchObject({ allowed: false });
  });

  it("allows reads without approval", () => {
    expect(engine.checkCall({ tool: read, role: "investigator" })).toMatchObject({ allowed: true, requiresApproval: false });
  });

  it("requires approval for every destructive tool", () => {
    expect(engine.checkCall({ tool: failover, role: "incident_commander" })).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it("applies require_approval rules to reversible writes", () => {
    expect(engine.checkCall({ tool: poolResize, role: "responder" })).toMatchObject({
      allowed: true,
      requiresApproval: true,
      reason: expect.stringMatching(/^approve-db-writes/),
    });
  });

  it("denies a tool matched by a deny rule even for the most privileged role", () => {
    expect(engine.checkCall({ tool: dropTable, role: "incident_commander" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/^never-drop-tables/),
    });
  });

  it("lets deny win over an approval rule listed before it", () => {
    const policy: Policy = {
      ...defaultPolicy(),
      rules: [
        { id: "approve", effect: "require_approval", tools: ["*"], reason: "x" },
        { id: "deny", effect: "deny", tools: ["flags.set"], reason: "y" },
      ],
    };
    expect(new PolicyEngine(policy).checkCall({ tool: flags, role: "responder" })).toMatchObject({ allowed: false });
  });

  it("skips rules scoped to other roles", () => {
    const policy: Policy = {
      ...defaultPolicy(),
      rules: [{ id: "no-flags-for-responders", effect: "deny", tools: ["flags.set"], roles: ["responder"], reason: "x" }],
    };
    expect(new PolicyEngine(policy).checkCall({ tool: flags, role: "incident_commander" })).toMatchObject({ allowed: true });
  });
});

describe("PolicyEngine.checkDryRun", () => {
  it("denies a write whose blast radius exceeds the limit", () => {
    const decision = engine.checkDryRun({ tool: flags, role: "responder", dryRun: preview(["api", "payments", "database"]), writesSoFar: 0 });
    expect(decision).toMatchObject({ allowed: false, reason: expect.stringMatching(/blast radius 3/) });
  });

  it("counts each affected service once", () => {
    const decision = engine.checkDryRun({ tool: flags, role: "responder", dryRun: preview(["api", "api", "api"]), writesSoFar: 0 });
    expect(decision.allowed).toBe(true);
  });

  it("denies once the per-run write limit is reached", () => {
    const decision = engine.checkDryRun({ tool: flags, role: "responder", dryRun: preview(["payments"]), writesSoFar: 3 });
    expect(decision).toMatchObject({ allowed: false, reason: expect.stringMatching(/write limit/) });
  });

  it("still applies call-level checks", () => {
    const decision = engine.checkDryRun({ tool: flags, role: "investigator", dryRun: preview([]), writesSoFar: 0 });
    expect(decision.allowed).toBe(false);
  });
});

describe("matchesPattern", () => {
  it("matches exact names, prefix wildcards and *", () => {
    expect(matchesPattern("db.failover", "db.failover")).toBe(true);
    expect(matchesPattern("db.*", "db.pool.resize")).toBe(true);
    expect(matchesPattern("*", "anything.at_all")).toBe(true);
  });

  it("does not let a prefix wildcard match a longer first segment", () => {
    expect(matchesPattern("db.*", "dbx.failover")).toBe(false);
  });
});
