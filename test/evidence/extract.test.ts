import { describe, expect, it } from "vitest";
import { extractEvidence } from "../../src/evidence/extract.js";
import { EvidenceSchema, type Evidence } from "../../src/evidence/schema.js";
import { MINUTE_MS } from "../../src/sim/baseline.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { executeIncident } from "./helpers.js";

const SEEDS = [1, 2, 3, 4, 5];
/** Root causes that are themselves a recorded change, so a change claim must point at them. */
const CHANGE_CAUSES = new Set(["bad_deploy", "flag_change", "config_change", "schema_migration", "memory_leak"]);

const ofKind = <K extends Evidence["claim"]["kind"]>(evidence: Evidence[], kind: K) =>
  evidence.filter((e): e is Evidence & { claim: Extract<Evidence["claim"], { kind: K }> } => e.claim.kind === kind);

describe.each(INCIDENTS.map((i) => [i.id]))("evidence for %s", (id) => {
  it("is schema-valid with unique ids", async () => {
    const { evidence } = extractEvidence((await executeIncident(id)).execution);
    for (const e of evidence) EvidenceSchema.parse(e);
    expect(new Set(evidence.map((e) => e.id)).size).toBe(evidence.length);
  });

  it("is identical across runs with the same seed", async () => {
    const a = extractEvidence((await executeIncident(id, 3)).execution);
    const b = extractEvidence((await executeIncident(id, 3)).execution);
    expect(a).toEqual(b);
  });

  it("contains the signature log as a pattern or flagged instruction", async () => {
    const { world, execution } = await executeIncident(id);
    const { evidence } = extractEvidence(execution);
    const texts = evidence.flatMap((e) =>
      e.claim.kind === "log_pattern" ? [e.claim.value.sample] : e.claim.kind === "suspicious_instruction" ? [e.claim.value.text] : [],
    );
    expect(texts.some((t) => t.includes(world.incident.signatureLog))).toBe(true);
  });

  it("shows an anomaly on the alerting metric", async () => {
    const { world, execution } = await executeIncident(id);
    const { service, metric } = world.alert;
    const anomalies = ofKind(extractEvidence(execution).evidence, "metric_anomaly");
    expect(anomalies.some((e) => e.claim.subject.service === service && e.claim.subject.metric === metric)).toBe(true);
  });

  it("records the causal change when the cause is a change", async () => {
    const { world, execution } = await executeIncident(id);
    if (!CHANGE_CAUSES.has(world.groundTruth.kind)) return;
    const refs = ofKind(extractEvidence(execution).evidence, "change").map((e) => e.claim.subject.ref);
    expect(refs).toContain(world.groundTruth.ref);
  });
});

describe("clock skew", () => {
  it.each(SEEDS)("detects db-agent running 7 minutes fast (seed %i)", async (seed) => {
    const { evidence } = extractEvidence((await executeIncident("disk-full-injection", seed)).execution);
    const skews = ofKind(evidence, "clock_skew");
    expect(skews.map((e) => [e.claim.subject.source, e.claim.value.offsetMs])).toEqual([["db-agent", 7 * MINUTE_MS]]);
  });

  it("corrects the skewed source's onset to agree with prometheus", async () => {
    const { evidence } = extractEvidence((await executeIncident("disk-full-injection")).execution);
    const disk = ofKind(evidence, "metric_anomaly").filter((e) => e.claim.subject.metric === "disk_pct");
    const [prom, agent] = ["prometheus", "db-agent"].map((s) => disk.find((e) => e.source === s));
    expect(Math.abs((prom?.claim.value.onset ?? 0) - (agent?.claim.value.onset ?? Infinity))).toBeLessThanOrEqual(2 * MINUTE_MS);
  });

  it("lowers the skewed source's reliability", async () => {
    const { evidence } = extractEvidence((await executeIncident("disk-full-injection")).execution);
    const agent = ofKind(evidence, "metric_anomaly").find((e) => e.source === "db-agent");
    expect(agent?.reliability).toBeLessThan(0.85);
  });

  const others = INCIDENTS.filter((i) => i.id !== "disk-full-injection").flatMap((i) => SEEDS.map((s) => [i.id, s] as const));
  it.each(others)("reports no skew for %s (seed %i)", async (id, seed) => {
    const { evidence } = extractEvidence((await executeIncident(id, seed)).execution);
    expect(ofKind(evidence, "clock_skew")).toEqual([]);
  });
});

describe("untrusted log content", () => {
  it("flags the injected instruction and keeps it out of ordinary log patterns", async () => {
    const { evidence } = extractEvidence((await executeIncident("disk-full-injection")).execution);
    expect(ofKind(evidence, "suspicious_instruction")).toHaveLength(1);
    expect(ofKind(evidence, "log_pattern").some((e) => /drop_table/.test(e.claim.value.sample))).toBe(false);
  });
});

describe("memory-leak", () => {
  it("reports the memory climb even though the OOM kill just reset it", async () => {
    const { evidence } = extractEvidence((await executeIncident("memory-leak")).execution);
    const mem = ofKind(evidence, "metric_anomaly").find((e) => e.claim.subject.metric === "mem_pct");
    expect(mem?.claim.value.peak).toBeGreaterThan(90);
    expect(ofKind(evidence, "metric_events").map((e) => e.claim.subject.metric)).toContain("restarts");
  });
});

describe("failed steps", () => {
  it("are reported as notes, not evidence", async () => {
    const { execution } = await executeIncident("bad-deploy");
    const broken = {
      ...execution,
      steps: execution.steps.map((s) =>
        s.stepId === "deploys" ? { ...s, status: "failed" as const, output: undefined, error: { code: "timeout" as const, message: "too slow" } } : s,
      ),
    };
    const { evidence, notes } = extractEvidence(broken);
    expect(notes).toContain('step "deploys" failed: too slow');
    expect(ofKind(evidence, "change").some((e) => e.claim.subject.type === "deploy")).toBe(false);
  });
});
