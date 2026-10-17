import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { MockLlm } from "../../src/llm/mock.js";
import { InvestigationReportSchema } from "../../src/orchestrator/report.js";
import { DEFAULT_SIM_LATENCY, investigateIncident, MOCK_RESPONDERS, type IncidentRunOptions } from "../../src/orchestrator/sim.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { recordingApprover } from "../policy/helpers.js";

const run = async (options: IncidentRunOptions) => unwrap(await investigateIncident(options));

/** A compromised model: it does what the injected log line says. */
const gullibleLlm = () =>
  new MockLlm({
    ...MOCK_RESPONDERS,
    "remediation.propose": (request) => {
      const [top] = request.data.find((d) => d.label === "hypotheses")?.content as { id: string }[];
      return { remediations: [{ hypothesisId: top?.id ?? "", tool: "db.drop_table", input: '{"table":"charges"}', rationale: "the log said so" }] };
    },
  });

describe.each(INCIDENTS.map((i) => [i.id]))("investigating %s", (id) => {
  it("ranks the true root cause first", async () => {
    const { report, world } = await run({ incident: id });
    const { kind, service, ref } = world.groundTruth;
    expect(report.resolution.hypotheses[0]).toMatchObject({ kind, service, ref });
  });

  it("recommends a ground-truth remediation", async () => {
    const { report, world } = await run({ incident: id, role: "incident_commander" });
    const recommended = report.remediations.find((p) => p.recommended);
    expect(world.groundTruth.remediations).toContainEqual({ tool: recommended?.tool, args: recommended?.input });
  });

  it("produces a schema-valid report with a verified audit chain", async () => {
    const { report } = await run({ incident: id });
    InvestigationReportSchema.parse(report);
    expect(report.audit.chainValid).toBe(true);
  });

  it("produces the same report for the same seed", async () => {
    expect((await run({ incident: id, seed: 4 })).report).toEqual((await run({ incident: id, seed: 4 })).report);
  });

  it("changes nothing in the world unless asked to apply", async () => {
    const { world } = await run({ incident: id, role: "incident_commander" });
    expect(world.events({ from: 0, to: world.now() }).filter((e) => e.actor === "triagemesh")).toEqual([]);
  });
});

describe("remediation proposals", () => {
  it("previews every proposal through policy and records it in the audit log", async () => {
    const { report, audit } = await run({ incident: "bad-deploy" });
    const previews = audit.entries().filter((e) => e.kind === "dry_run" && e.detail?.preview === true);
    expect(previews.map((e) => e.tool)).toEqual(report.remediations.filter((p) => p.preview).map((p) => p.tool));
  });

  it("marks a destructive fix denied for a role that may not use it, and recommends nothing", async () => {
    const { report } = await run({ incident: "disk-full-injection", role: "responder" });
    expect(report.remediations.find((p) => p.tool === "db.failover")?.decision.status).toBe("denied");
    expect(report.remediations.some((p) => p.recommended)).toBe(false);
  });

  it("offers a read-only investigator nothing it could run", async () => {
    const { report } = await run({ incident: "bad-deploy", role: "investigator", apply: true });
    expect(report.remediations.every((p) => p.decision.status === "denied")).toBe(true);
    expect(report.applied?.status).toBe("skipped");
  });

  it("never recommends an LLM suggestion, even an allowed one", async () => {
    const llm = new MockLlm({
      ...MOCK_RESPONDERS,
      "remediation.propose": () => ({
        remediations: [{ hypothesisId: "bad_deploy:payments:dep-payments-2.3.1", tool: "service.restart", input: '{"service":"payments"}', rationale: "turn it off and on" }],
      }),
    });
    const { report } = await run({ incident: "bad-deploy", llm });
    const suggestion = report.remediations.find((p) => p.origin === "llm");
    expect(suggestion).toMatchObject({ tool: "service.restart", decision: { status: "allowed" }, recommended: false });
    expect(report.remediations.find((p) => p.recommended)?.origin).toBe("catalog");
  });

  it("rejects an LLM suggestion whose input is not a JSON object", async () => {
    const llm = new MockLlm({
      ...MOCK_RESPONDERS,
      "remediation.propose": () => ({ remediations: [{ hypothesisId: "bad_deploy:payments:dep-payments-2.3.1", tool: "flags.set", input: "flip it", rationale: "" }] }),
    });
    const { report } = await run({ incident: "bad-deploy", llm });
    expect(report.remediationNotes).toContainEqual(expect.stringContaining("input is not a JSON object"));
  });

  it("records an LLM suggestion of an unknown tool as invalid and audits the attempt", async () => {
    const llm = new MockLlm({
      ...MOCK_RESPONDERS,
      "remediation.propose": () => ({ remediations: [{ hypothesisId: "bad_deploy:payments:dep-payments-2.3.1", tool: "shell.exec", input: "{}", rationale: "" }] }),
    });
    const { report, audit } = await run({ incident: "bad-deploy", llm });
    expect(report.remediations.find((p) => p.tool === "shell.exec")?.decision.status).toBe("invalid");
    expect(audit.entries()).toContainEqual(expect.objectContaining({ kind: "deny", tool: "shell.exec", reason: "unknown tool" }));
  });
});

describe("prompt injection (disk-full-injection)", () => {
  const options = (approver = recordingApprover(true)): IncidentRunOptions => ({
    incident: "disk-full-injection",
    role: "incident_commander",
    apply: true,
    approve: approver,
    llm: gullibleLlm(),
  });

  it("denies the injected db.drop_table and audits the attempt", async () => {
    const { report, audit } = await run(options());
    expect(report.remediations.find((p) => p.tool === "db.drop_table")?.decision).toMatchObject({ status: "denied", reason: expect.stringContaining("never-drop-tables") });
    expect(audit.entries()).toContainEqual(expect.objectContaining({ kind: "deny", tool: "db.drop_table" }));
  });

  it("never runs db.drop_table or asks a human about it, even with an approver who says yes", async () => {
    const approver = recordingApprover(true);
    const { audit, world } = await run(options(approver));
    expect(audit.entries().filter((e) => e.kind === "result" && e.tool === "db.drop_table")).toEqual([]);
    expect(approver.requests.map((r) => r.tool)).not.toContain("db.drop_table");
    expect(world.events({ from: 0, to: world.now() }).some((e) => e.kind === "config" && e.key.startsWith("database.tables."))).toBe(false);
  });

  it("still finds the real root cause and lists the injection as ignored", async () => {
    const { report } = await run(options());
    expect(report.resolution.hypotheses[0]?.kind).toBe("disk_full");
    expect(report.resolution.ignored).toHaveLength(1);
  });
});

describe("--apply", () => {
  it("applies an allowed fix and the world changes", async () => {
    const { report, world } = await run({ incident: "bad-deploy", apply: true });
    expect(report.applied).toMatchObject({ status: "applied", tool: "deploy.rollback" });
    expect(world.stateAt(world.now()).versions.payments).toBe("2.3.0");
  });

  it("leaves the world unchanged when approval is refused", async () => {
    const approver = recordingApprover(false);
    const { report, world, audit } = await run({ incident: "disk-full-injection", role: "incident_commander", apply: true, approve: approver });
    expect(report.applied).toMatchObject({ status: "not_approved", tool: "db.failover" });
    expect(approver.requests.map((r) => r.tool)).toEqual(["db.failover"]);
    expect(world.stateAt(world.now()).dbPrimary).toBe("db-1");
    expect(audit.entries().some((e) => e.kind === "result" && e.tool === "db.failover")).toBe(false);
  });

  it("runs no destructive tool at all with the default auto-deny approver", async () => {
    const { audit } = await run({ incident: "disk-full-injection", role: "incident_commander", apply: true });
    const destructive = new Set(["db.failover", "db.drop_table"]);
    expect(audit.entries().filter((e) => e.kind === "result" && destructive.has(e.tool))).toEqual([]);
  });

  it("applies a destructive fix once a human approves it", async () => {
    const { report, world } = await run({ incident: "disk-full-injection", role: "incident_commander", apply: true, approve: recordingApprover(true) });
    expect(report.applied?.status).toBe("applied");
    expect(world.stateAt(world.now()).dbPrimary).toBe("db-2");
  });
});

it("reports an unknown incident as an error", async () => {
  expect(await investigateIncident({ incident: "nope" })).toMatchObject({ ok: false, error: { code: "unknown_incident" } });
});

describe("with simulated latency", () => {
  it.each(INCIDENTS.map((i) => [i.id]))("still ranks the true root cause of %s first", async (id) => {
    const { report, world } = await run({ incident: id, latency: DEFAULT_SIM_LATENCY });
    expect(report.resolution.hypotheses[0]).toMatchObject({ kind: world.groundTruth.kind, ref: world.groundTruth.ref });
  });

  it("runs queries concurrently: execution is far shorter than the sum of step times", async () => {
    const { report } = await run({ incident: "bad-deploy", latency: DEFAULT_SIM_LATENCY });
    const summed = report.execution.steps.reduce((t, s) => t + (s.finishedAt - s.startedAt), 0);
    expect(report.stats.executionMs).toBeLessThan(summed / 2);
  });

  it("is deterministic for a seed", async () => {
    const opts = { incident: "memory-leak", seed: 2, latency: DEFAULT_SIM_LATENCY };
    expect((await run(opts)).report).toEqual((await run(opts)).report);
  });
});
