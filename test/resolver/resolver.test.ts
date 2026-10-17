import { describe, expect, it } from "vitest";
import { extractEvidence } from "../../src/evidence/extract.js";
import { MockLlm } from "../../src/llm/mock.js";
import { MAX_LLM_CANDIDATES, Resolver, acceptProposals } from "../../src/resolver/resolver.js";
import { ResolutionSchema, type ProposedHypotheses } from "../../src/resolver/schema.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { executeIncident } from "../evidence/helpers.js";
import { ALERT, at, evidenceBuilder } from "./helpers.js";

const SEEDS = [1, 2, 3, 4, 5];

async function resolveIncident(id: string, seed = 1, llm = new MockLlm()) {
  const { world, execution } = await executeIncident(id, seed);
  const { evidence } = extractEvidence(execution);
  return { world, evidence, resolution: await new Resolver({ llm }).resolve(world.alert, evidence) };
}

describe.each(INCIDENTS.map((i) => [i.id]))("resolving %s", (id) => {
  it.each(SEEDS)("ranks the true root cause first (seed %i)", async (seed) => {
    const { world, resolution } = await resolveIncident(id, seed);
    const { kind, service, ref } = world.groundTruth;
    expect(resolution.hypotheses[0]).toMatchObject({ kind, service, ref });
  });

  it("is schema-valid", async () => {
    ResolutionSchema.parse((await resolveIncident(id)).resolution);
  });

  it("is identical across runs with the same seed", async () => {
    expect((await resolveIncident(id, 3)).resolution).toEqual((await resolveIncident(id, 3)).resolution);
  });
});

describe("adversarial incidents", () => {
  it("records upstream-gateway's red-herring deploy as after onset and scores it negative", async () => {
    const { resolution } = await resolveIncident("upstream-gateway");
    const deploy = resolution.hypotheses.find((h) => h.ref === "dep-payments-2.4.0");
    expect(deploy?.score).toBeLessThan(0);
    expect(resolution.conflicts).toContainEqual(
      expect.objectContaining({ kind: "temporal", resolution: "cause_after_effect", subject: expect.stringContaining("dep-payments-2.4.0") }),
    );
  });

  it("flags db-agent's skewed clock in disk-full-injection", async () => {
    const { resolution } = await resolveIncident("disk-full-injection");
    expect(resolution.flaggedSources.map((f) => f.source)).toContain("db-agent");
    expect(resolution.conflicts).toContainEqual(expect.objectContaining({ resolution: "skew_corrected", subject: "db-agent clock" }));
  });

  it("reports the injected instruction as ignored and never weighs it", async () => {
    const { evidence, resolution } = await resolveIncident("disk-full-injection");
    const injected = evidence.filter((e) => e.claim.kind === "suspicious_instruction").map((e) => e.id);
    expect(injected).not.toHaveLength(0);
    expect(resolution.ignored.map((i) => i.evidenceId)).toEqual(injected);
    const linked = new Set(resolution.hypotheses.flatMap((h) => [...h.for, ...h.against]).map((l) => l.evidenceId));
    for (const id of injected) expect(linked.has(id)).toBe(false);
  });
});

describe("LLM-suggested hypotheses", () => {
  const scenario = () => {
    const b = evidenceBuilder();
    return [
      b.deploy("dep-1", "payments", 80),
      b.flag("payments.retries", "payments", 60),
      b.anomaly("payments", "error_rate", 81),
      b.log("database", "WARN", "slow query 2.3s -- Seq Scan on charges", 81),
    ];
  };
  const llmSaying = (reply: unknown) => new MockLlm({ "resolver.hypotheses": () => reply });

  it("falls back to rule candidates when the LLM is unavailable", async () => {
    const resolution = await new Resolver({ llm: new MockLlm() }).resolve(ALERT, scenario());
    expect(resolution.hypotheses.every((h) => h.origin === "rule")).toBe(true);
    expect(resolution.notes).toEqual([expect.stringContaining("rule candidates only: LLM unavailable")]);
  });

  it("falls back to rule candidates when the LLM reply is malformed", async () => {
    const resolution = await new Resolver({ llm: llmSaying({ hypotheses: [{ kind: "aliens" }] }) }).resolve(ALERT, scenario());
    expect(resolution.notes).toEqual([expect.stringContaining("invalid_output")]);
  });

  it("adds a suggestion anchored to a real change, taking its time from the record", async () => {
    const reply = { hypotheses: [{ kind: "config_change", service: "api", ref: "dep-1", rationale: "pool settings" }] };
    const resolution = await new Resolver({ llm: llmSaying(reply) }).resolve(ALERT, scenario());
    // The model said "api"; the change record says payments, and the record wins.
    expect(resolution.hypotheses).toContainEqual(expect.objectContaining({ kind: "config_change", service: "payments", ref: "dep-1", start: at(80), origin: "llm" }));
  });

  it("scores a suggestion with the same code as rule candidates", async () => {
    const reply = { hypotheses: [{ kind: "config_change", service: "payments", ref: "payments.retries", rationale: "retry config" }] };
    const resolution = await new Resolver({ llm: llmSaying(reply) }).resolve(ALERT, scenario());
    const suggested = resolution.hypotheses.find((h) => h.origin === "llm");
    expect(suggested?.for.length).toBeGreaterThan(0);
    expect(suggested?.rank).toBeGreaterThan(1);
  });

  it("rejects a suggestion about a change nobody recorded", () => {
    const { candidates, notes } = acceptProposals({ hypotheses: [{ kind: "bad_deploy", service: "payments", ref: "dep-imaginary", rationale: "" }] }, scenario(), []);
    expect(candidates).toEqual([]);
    expect(notes).toEqual([expect.stringContaining("rejected: no evidence supports it")]);
  });

  it("rejects a condition with no sign of its mechanism", () => {
    const { candidates } = acceptProposals({ hypotheses: [{ kind: "disk_full", service: "database", ref: null, rationale: "" }] }, scenario(), []);
    expect(candidates).toEqual([]);
  });

  it("does not duplicate an existing candidate", () => {
    const evidence = scenario();
    const existing = [{ kind: "bad_deploy" as const, service: "payments" as const, ref: "dep-1", start: at(80), title: "", origin: "rule" as const }];
    const { candidates } = acceptProposals({ hypotheses: [{ kind: "bad_deploy", service: "payments", ref: "dep-1", rationale: "" }] }, evidence, existing);
    expect(candidates).toEqual([]);
  });

  it(`accepts at most ${MAX_LLM_CANDIDATES} suggestions`, () => {
    const b = evidenceBuilder();
    const evidence = Array.from({ length: 8 }, (_, i) => b.deploy(`dep-${i}`, "payments", 70 + i));
    const proposals: ProposedHypotheses = { hypotheses: evidence.map((_, i) => ({ kind: "config_change", service: "payments", ref: `dep-${i}`, rationale: "" })) };
    expect(acceptProposals(proposals, evidence, []).candidates).toHaveLength(MAX_LLM_CANDIDATES);
  });
});
