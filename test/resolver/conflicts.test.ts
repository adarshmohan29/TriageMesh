import { describe, expect, it } from "vitest";
import type { Evidence } from "../../src/evidence/schema.js";
import { ruleCandidates } from "../../src/resolver/candidates.js";
import { detectConflicts, findSymptom, independentTrust } from "../../src/resolver/conflicts.js";
import { resolveWith } from "../../src/resolver/resolver.js";
import { ConflictRecordSchema } from "../../src/resolver/schema.js";
import { ALERT, at, evidenceBuilder } from "./helpers.js";

const analyse = (evidence: Evidence[]) => detectConflicts(ALERT, evidence, findSymptom(ALERT, evidence));

describe("value and presence conflicts", () => {
  it("lets two agreeing higher-trust sources beat one low-trust source", () => {
    const b = evidenceBuilder();
    const metric = b.anomaly("payments", "error_rate", 80, "prometheus");
    const logs = b.log("payments", "ERROR", "TypeError: Cannot read properties of undefined", 80);
    const lowTrust = b.normal("payments", "error_rate", "db-agent", 0.55);
    const { conflicts, overruled, flaggedSources } = analyse([metric, logs, lowTrust]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "presence", winner: "a", resolution: "trust_weighted", a: [metric.id, logs.id], b: [lowTrust.id] });
    expect([...overruled]).toEqual([lowTrust.id]);
    expect(flaggedSources).toEqual([{ source: "db-agent", reason: "overruled on payments.error_rate" }]);
  });

  it("calls a metric-vs-metric disagreement a value conflict", () => {
    const b = evidenceBuilder();
    const { conflicts } = analyse([b.anomaly("payments", "cpu_pct", 80), b.normal("payments", "cpu_pct", "db-agent")]);
    expect(conflicts[0]).toMatchObject({ kind: "value", subject: "payments.cpu_pct", winner: "a" });
  });

  it("does not let one source outvote another by repeating itself", () => {
    const b = evidenceBuilder();
    const repeats = [1, 2, 3].map(() => b.normal("payments", "cpu_pct", "db-agent"));
    const winner = b.anomaly("payments", "cpu_pct", 80, "prometheus");
    const { overruled } = analyse([...repeats, winner]);
    expect([...overruled].sort()).toEqual(repeats.map((e) => e.id));
  });

  it("sets both sides aside when trust is too close to call", () => {
    const b = evidenceBuilder();
    const up = b.anomaly("payments", "cpu_pct", 80, "prometheus", 0.85);
    const normal = b.normal("payments", "cpu_pct", "db-agent", 0.84);
    const { conflicts, overruled, flaggedSources } = analyse([up, normal]);
    expect(conflicts[0]).toMatchObject({ resolution: "unresolved", winner: "none" });
    expect([...overruled].sort()).toEqual([up.id, normal.id]);
    expect(flaggedSources).toEqual([]);
  });

  it("finds no conflict when sources agree", () => {
    const b = evidenceBuilder();
    expect(analyse([b.anomaly("payments", "cpu_pct", 80), b.anomaly("payments", "cpu_pct", 80, "db-agent")]).conflicts).toEqual([]);
  });

  it("drops overruled evidence from hypothesis scoring", () => {
    const b = evidenceBuilder();
    const lowTrust = b.anomaly("payments", "cpu_pct", 81, "db-agent", 0.3);
    const evidence = [b.deploy("dep-1", "payments", 80), b.anomaly("payments", "error_rate", 81), b.normal("payments", "cpu_pct"), lowTrust];
    const { hypotheses } = resolveWith(ALERT, evidence, ruleCandidates(ALERT, evidence));
    expect(hypotheses.flatMap((h) => h.for).map((l) => l.evidenceId)).not.toContain(lowTrust.id);
  });

  it("counts each source once when summing a side's trust", () => {
    const b = evidenceBuilder();
    const trust = independentTrust([b.normal("api", "cpu_pct", "db-agent", 0.5), b.normal("api", "cpu_pct", "db-agent", 0.7), b.normal("api", "cpu_pct", "prometheus", 0.9)]);
    expect(trust).toBeCloseTo(1.6);
  });
});

describe("temporal conflicts", () => {
  it("records a change after the symptom began as cause-after-effect", () => {
    const b = evidenceBuilder();
    const symptom = b.anomaly("payments", "error_rate", 80);
    const late = b.deploy("dep-late", "payments", 84);
    const { conflicts } = analyse([symptom, late]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "temporal", resolution: "cause_after_effect", a: [late.id], b: [symptom.id], winner: "b" }),
    ]);
    expect(conflicts[0]?.rationale).toContain("4m after onset");
  });

  it("does not flag a change that landed before the symptom", () => {
    const b = evidenceBuilder();
    expect(analyse([b.anomaly("payments", "error_rate", 80), b.deploy("dep-1", "payments", 79)]).conflicts).toEqual([]);
  });

  it("flags a skewed source and records the corrected timeline", () => {
    const b = evidenceBuilder();
    const skewed = b.anomaly("database", "disk_pct", 50, "db-agent", 0.55);
    const reference = b.anomaly("database", "disk_pct", 50, "prometheus");
    const { conflicts, flaggedSources } = analyse([b.skew("db-agent", 7, ["database.disk_pct"]), skewed, reference]);

    expect(flaggedSources).toEqual([{ source: "db-agent", reason: expect.stringContaining("7m fast") }]);
    expect(conflicts[0]).toMatchObject({ kind: "temporal", resolution: "skew_corrected", a: [skewed.id], b: [reference.id], winner: "b" });
  });

  it("uses the most trusted source for the symptom onset", () => {
    const b = evidenceBuilder();
    const symptom = findSymptom(ALERT, [b.anomaly("payments", "error_rate", 70, "db-agent", 0.55), b.anomaly("payments", "error_rate", 80)]);
    expect(symptom.onset).toBe(at(80));
  });

  it("falls back to the alert time when the alerting metric shows no anomaly", () => {
    expect(findSymptom(ALERT, [])).toEqual({ onset: ALERT.firedAt, evidenceIds: [] });
  });
});

it("produces schema-valid conflict records", () => {
  const b = evidenceBuilder();
  const { conflicts } = analyse([
    b.anomaly("payments", "error_rate", 80),
    b.deploy("dep-late", "payments", 84),
    b.normal("payments", "error_rate", "db-agent", 0.4),
  ]);
  expect(conflicts.length).toBe(2);
  for (const c of conflicts) ConflictRecordSchema.parse(c);
});
