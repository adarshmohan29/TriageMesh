import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { makeInvoker, recordingApprover } from "./helpers.js";

describe("GuardedInvoker.preview", () => {
  it("returns the dry run and policy decision without running the tool", async () => {
    const { invoker, world } = makeInvoker("bad-deploy");
    const preview = unwrap(await invoker.preview("deploy.rollback", { service: "payments" }, { role: "responder" }));
    expect(preview).toMatchObject({ tier: "reversible_write", requiresApproval: false });
    expect(preview.dryRun.summary).toContain("undoes dep-payments-2.3.1");
    expect(world.stateAt(world.now()).versions.payments).toBe("2.3.1");
  });

  it("reports that approval would be needed but never asks for it", async () => {
    const approver = recordingApprover(true);
    const { invoker, world } = makeInvoker("disk-full-injection", { approve: approver });
    const preview = unwrap(await invoker.preview("db.failover", { to: "db-2" }, { role: "incident_commander" }));
    expect(preview.requiresApproval).toBe(true);
    expect(approver.requests).toEqual([]);
    expect(world.stateAt(world.now()).dbPrimary).toBe("db-1");
  });

  it("audits the preview as a dry run, marked as a preview", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    await invoker.preview("deploy.rollback", { service: "payments" }, { role: "responder" });
    expect(audit.entries().map((e) => [e.kind, e.detail?.preview])).toEqual([["dry_run", true]]);
  });

  it("denies and audits a write the role may not use", async () => {
    const { invoker, audit } = makeInvoker("bad-deploy");
    const preview = await invoker.preview("deploy.rollback", { service: "payments" }, { role: "investigator" });
    expect(preview).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(audit.entries().map((e) => e.kind)).toEqual(["deny"]);
  });

  it("denies a tool that policy forbids outright", async () => {
    const { invoker } = makeInvoker("disk-full-injection");
    const preview = await invoker.preview("db.drop_table", { table: "charges" }, { role: "incident_commander" });
    expect(preview).toMatchObject({ ok: false, error: { code: "denied", message: expect.stringContaining("never-drop-tables") } });
  });

  it("refuses read tools", async () => {
    const { invoker } = makeInvoker("bad-deploy");
    expect(await invoker.preview("logs.search", {}, { role: "responder" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("does not count toward the per-run write limit", async () => {
    const { invoker } = makeInvoker("bad-deploy");
    for (let i = 0; i < 5; i++) await invoker.preview("service.restart", { service: "api" }, { role: "responder" });
    expect(invoker.writeCount).toBe(0);
    expect((await invoker.invoke("service.restart", { service: "api" }, { role: "responder" })).ok).toBe(true);
  });
});
