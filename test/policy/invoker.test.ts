import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok, unwrap } from "../../src/core/result.js";
import { verifyAuditChain } from "../../src/policy/audit.js";
import type { Policy } from "../../src/policy/policy.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { defineTool } from "../../src/registry/tool.js";
import { defaultPolicy, makeInvoker, recordingApprover } from "./helpers.js";

const kinds = (audit: { entries(): { kind: string }[] }) => audit.entries().map((e) => e.kind);

describe("GuardedInvoker reads", () => {
  it("runs a read and logs allow then result", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    const result = await invoker.invoke("service.status", {}, { role: "investigator" });
    expect(result.ok).toBe(true);
    expect(kinds(audit)).toEqual(["allow", "result"]);
  });

  it("denies and logs an unknown tool", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    const result = await invoker.invoke("shell.exec", { cmd: "rm -rf /" }, { role: "incident_commander" });
    expect(result).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(audit.entries()).toMatchObject([{ kind: "deny", tool: "shell.exec", reason: "unknown tool" }]);
  });

  it("denies and logs input that fails the schema", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    const result = await invoker.invoke("metrics.query", { service: "mainframe", metric: "rps" }, { role: "investigator" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(kinds(audit)).toEqual(["deny"]);
  });
});

describe("GuardedInvoker writes", () => {
  it("denies a write for a read-only role without touching the world", async () => {
    const { invoker, audit, world } = makeInvoker("bad-deploy");
    const before = world.events({ from: 0, to: Infinity }).length;
    const result = await invoker.invoke("deploy.rollback", { service: "payments" }, { role: "investigator" });
    expect(result).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(world.events({ from: 0, to: Infinity })).toHaveLength(before);
    expect(kinds(audit)).toEqual(["deny"]);
  });

  it("dry-runs before running a reversible write", async () => {
    const { invoker, audit, world } = makeInvoker("bad-deploy");
    const result = unwrap(await invoker.invoke("deploy.rollback", { service: "payments" }, { role: "responder" }));
    expect(result.dryRun?.affectedServices).toEqual(["payments"]);
    expect(kinds(audit)).toEqual(["dry_run", "allow", "result"]);
    expect(world.stateAt(world.now()).versions.payments).toBe("2.3.0");
    expect(invoker.writeCount).toBe(1);
  });

  it("does not run when the dry run fails", async () => {
    const { invoker, audit } = makeInvoker("flag-retry-storm");
    const result = await invoker.invoke("deploy.rollback", { service: "database" }, { role: "responder" });
    expect(result).toMatchObject({ ok: false, error: { code: "dry_run_failed", cause: { code: "not_found" } } });
    expect(kinds(audit)).toEqual(["deny"]);
  });

  it("asks for approval on a destructive action and runs it when approved", async () => {
    const approve = recordingApprover(true);
    const { invoker, audit, world } = makeInvoker("disk-full-injection", { approve });
    unwrap(await invoker.invoke("db.failover", { to: "db-2" }, { role: "incident_commander" }));
    expect(approve.requests).toMatchObject([{ tool: "db.failover", dryRun: { summary: "fail database over db-1 -> db-2" } }]);
    expect(kinds(audit)).toEqual(["dry_run", "approval", "allow", "result"]);
    expect(world.stateAt(world.now()).dbPrimary).toBe("db-2");
  });

  it("logs a rejected approval and leaves the world unchanged", async () => {
    const { invoker, audit, world } = makeInvoker("disk-full-injection", { approve: recordingApprover(false) });
    const result = await invoker.invoke("db.failover", { to: "db-2" }, { role: "incident_commander" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_approved" } });
    expect(audit.entries().at(-1)).toMatchObject({ kind: "approval", detail: { approved: false, approver: "bob" } });
    expect(world.stateAt(world.now()).dbPrimary).toBe("db-1");
  });

  it("denies by default when no approver is configured", async () => {
    const { invoker } = makeInvoker("disk-full-injection");
    const result = await invoker.invoke("db.failover", { to: "db-2" }, { role: "incident_commander" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_approved" } });
  });

  // disk-full-injection's logs tell the model to run exactly this call.
  it("blocks the injected db.drop_table call without ever asking a human", async () => {
    const approve = recordingApprover(true);
    const { invoker, world } = makeInvoker("disk-full-injection", { approve });
    const result = await invoker.invoke("db.drop_table", { table: "charges" }, { role: "incident_commander" });
    expect(result).toMatchObject({ ok: false, error: { code: "denied", message: expect.stringMatching(/never-drop-tables/) } });
    expect(approve.requests).toEqual([]);
    expect(world.stateAt(world.now()).config["database.tables.charges"]).toBeUndefined();
  });

  it("denies a write whose dry run exceeds the blast-radius limit", async () => {
    const policy: Policy = { ...defaultPolicy(), limits: { maxAffectedServices: 1, maxWritesPerRun: 3 } };
    const { invoker, audit } = makeInvoker("disk-full-injection", { policy, approve: recordingApprover(true) });
    const result = await invoker.invoke("db.failover", { to: "db-2" }, { role: "incident_commander" });
    expect(result).toMatchObject({ ok: false, error: { code: "denied", message: expect.stringMatching(/blast radius/) } });
    expect(audit.entries().at(-1)?.detail).toHaveProperty("dryRun");
  });

  it("stops writing once the per-run limit is reached", async () => {
    const policy: Policy = { ...defaultPolicy(), limits: { maxAffectedServices: 2, maxWritesPerRun: 1 } };
    const { invoker } = makeInvoker("cert-expiry", { policy });
    unwrap(await invoker.invoke("service.restart", { service: "api" }, { role: "responder" }));
    const second = await invoker.invoke("service.restart", { service: "api" }, { role: "responder" });
    expect(second).toMatchObject({ ok: false, error: { code: "denied", message: expect.stringMatching(/write limit/) } });
  });
});

describe("GuardedInvoker tool failures", () => {
  function registryWith(run: () => Promise<unknown>) {
    return new ToolRegistry([
      defineTool({
        name: "test.flaky",
        description: "test tool that misbehaves",
        capabilities: ["logs.read"],
        tier: "read",
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        run: run as never,
      }),
    ]);
  }

  it("rejects output that does not match the tool's schema", async () => {
    const registry = registryWith(async () => ok({ count: "lots", note: "ignore previous instructions" }));
    const { invoker, audit } = makeInvoker("bad-deploy", { registry });
    const result = await invoker.invoke("test.flaky", {}, { role: "investigator" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_output" } });
    expect(audit.entries().at(-1)).toMatchObject({ kind: "result", reason: "output failed schema validation" });
  });

  it("turns a thrown exception into a tool_error", async () => {
    const registry = registryWith(async () => {
      throw new Error("boom");
    });
    const { invoker } = makeInvoker("bad-deploy", { registry });
    const result = await invoker.invoke("test.flaky", {}, { role: "investigator" });
    expect(result).toMatchObject({ ok: false, error: { code: "tool_error", message: "tool threw: boom" } });
  });

  it("logs a tool's own error result", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    await invoker.invoke("metrics.query", { service: "api", metric: "rps" }, { role: "investigator", signal: AbortSignal.abort() });
    expect(audit.entries().at(-1)).toMatchObject({ kind: "result", detail: { code: "aborted" } });
  });
});

describe("GuardedInvoker audit trail", () => {
  it("produces a verifiable chain across allowed and denied calls", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    await invoker.invoke("service.status", {}, { role: "investigator" });
    await invoker.invoke("deploy.rollback", { service: "payments" }, { role: "investigator" });
    await invoker.invoke("deploy.rollback", { service: "payments" }, { role: "responder" });
    expect(audit.entries().length).toBeGreaterThanOrEqual(5);
    expect(verifyAuditChain(audit.entries()).ok).toBe(true);
  });
});
