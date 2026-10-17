import { Chalk } from "chalk";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { terminalApprover } from "../../src/cli/approval.js";
import { parseInvestigateArgs } from "../../src/cli/args.js";
import { formatReport } from "../../src/cli/format.js";
import { unwrap } from "../../src/core/result.js";
import { investigateIncident } from "../../src/orchestrator/sim.js";
import { denyAll, type ApprovalRequest } from "../../src/policy/approval.js";

const plain = new Chalk({ level: 0 });

describe("parseInvestigateArgs", () => {
  it("applies defaults", () => {
    expect(unwrap(parseInvestigateArgs(["--incident", "bad-deploy"]))).toMatchObject({ incident: "bad-deploy", role: "responder", seed: 1, json: false, apply: false });
  });

  it("reads every option", () => {
    const args = unwrap(parseInvestigateArgs(["--incident", "x", "--role", "incident_commander", "--seed", "7", "--json", "--apply", "--audit", "a.jsonl"]));
    expect(args).toMatchObject({ role: "incident_commander", seed: 7, json: true, apply: true, audit: "a.jsonl" });
  });

  it("requires an incident unless listing", () => {
    expect(parseInvestigateArgs([]).ok).toBe(false);
    expect(parseInvestigateArgs(["--list"]).ok).toBe(true);
  });

  it("rejects a bad seed and unknown flags", () => {
    expect(parseInvestigateArgs(["--incident", "x", "--seed", "-1"]).ok).toBe(false);
    expect(parseInvestigateArgs(["--incident", "x", "--yolo"]).ok).toBe(false);
  });
});

describe("formatReport", () => {
  it("shows the leading hypothesis, the recommended fix and the audit status", async () => {
    const { report } = unwrap(await investigateIncident({ incident: "bad-deploy" }));
    const text = formatReport(report, plain);
    expect(text).toContain("#1 bad_deploy in payments (dep-payments-2.3.1)");
    expect(text).toMatch(/★ deploy\.rollback \{"service":"payments"\}/);
    expect(text).toContain("chain verified");
  });

  it("shows the after-onset conflict for upstream-gateway", async () => {
    const { report } = unwrap(await investigateIncident({ incident: "upstream-gateway" }));
    expect(formatReport(report, plain)).toContain("dep-payments-2.4.0 vs payments.latency_p95_ms [cause_after_effect]");
  });

  it("flags the skewed source and the ignored injection", async () => {
    const { report } = unwrap(await investigateIncident({ incident: "disk-full-injection" }));
    const text = formatReport(report, plain);
    expect(text).toContain("db-agent: clock runs 7m fast");
    expect(text).toMatch(/ignored: log text that tries to instruct/);
  });
});

describe("terminalApprover", () => {
  const request: ApprovalRequest = {
    tool: "db.failover",
    tier: "destructive",
    role: "incident_commander",
    input: { to: "db-2" },
    dryRun: { summary: "fail database over db-1 -> db-2", changes: [], affectedServices: ["database"] },
    reason: "destructive tier requires approval",
  };

  it("denies everything when there is no terminal", () => {
    expect(terminalApprover({ input: new PassThrough(), output: new PassThrough(), approver: "me" })).toBe(denyAll);
  });

  it.each([
    ["y\n", true],
    ["\n", false],
    ["nope\n", false],
  ])("answers %j as approved=%s", async (answer, approved) => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const pending = terminalApprover({ input, output, approver: "me" })(request);
    input.write(answer);
    expect(await pending).toMatchObject({ approved, approver: "me" });
  });

  it("shows the dry run before asking", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const pending = terminalApprover({ input, output, approver: "me" })(request);
    input.write("n\n");
    await pending;
    expect(String(output.read())).toContain("would: fail database over db-1 -> db-2");
  });
});
