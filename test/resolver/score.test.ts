import { describe, expect, it } from "vitest";
import type { Evidence } from "../../src/evidence/schema.js";
import { ruleCandidates } from "../../src/resolver/candidates.js";
import { findSymptom } from "../../src/resolver/conflicts.js";
import { resolveWith } from "../../src/resolver/resolver.js";
import type { Candidate, Hypothesis } from "../../src/resolver/schema.js";
import { proximity, scoreCandidates } from "../../src/resolver/score.js";
import { MINUTE_MS } from "../../src/sim/baseline.js";
import { ALERT, at, evidenceBuilder } from "./helpers.js";

function rank(evidence: Evidence[], candidates = ruleCandidates(ALERT, evidence)): Hypothesis[] {
  return scoreCandidates(candidates, evidence, { symptom: findSymptom(ALERT, evidence), excluded: new Set() });
}

const byRef = (hypotheses: Hypothesis[], ref: string) => hypotheses.find((h) => h.ref === ref);

describe("temporal causality", () => {
  it("counts a deploy before the symptom onset as support", () => {
    const b = evidenceBuilder();
    const deploy = b.deploy("dep-1", "payments", 80);
    const [h] = rank([deploy, b.anomaly("payments", "error_rate", 82)]);
    expect(h?.for.map((l) => l.evidenceId)).toContain(deploy.id);
    expect(h?.score).toBeGreaterThan(0);
  });

  it("counts a deploy after the symptom onset against it, not for it", () => {
    const b = evidenceBuilder();
    const deploy = b.deploy("dep-late", "payments", 84);
    const [h] = rank([b.anomaly("payments", "error_rate", 80), deploy]);
    expect(h?.against.map((l) => l.evidenceId)).toContain(deploy.id);
    expect(h?.for.map((l) => l.evidenceId)).not.toContain(deploy.id);
    expect(h?.score).toBeLessThan(0);
  });

  it("treats a change in the same minute as the onset as before it", () => {
    const b = evidenceBuilder();
    const [h] = rank([b.deploy("dep-1", "payments", 82), b.anomaly("payments", "error_rate", 82)]);
    expect(h?.against).toEqual([]);
  });

  it("gives a change close to the onset more credit than an older one", () => {
    const b = evidenceBuilder();
    const ranked = rank([b.deploy("recent", "payments", 78), b.deploy("old", "payments", 20), b.anomaly("payments", "error_rate", 80)]);
    expect(ranked.map((h) => h.ref)).toEqual(["recent", "old"]);
  });

  it("gives full credit within 10 minutes and halves it every 20 after", () => {
    expect(proximity(10 * MINUTE_MS)).toBe(1);
    expect(proximity(30 * MINUTE_MS)).toBeCloseTo(0.5);
    expect(proximity(-MINUTE_MS)).toBe(1);
    expect(proximity(1000 * MINUTE_MS)).toBe(0.05);
  });
});

describe("independent sources", () => {
  it("does not double-count the same observation repeated by one source", () => {
    const b = evidenceBuilder();
    const deploy = b.deploy("dep-1", "payments", 80);
    const once = rank([deploy, b.anomaly("payments", "error_rate", 81)]);
    const twice = rank([deploy, b.anomaly("payments", "error_rate", 81), b.anomaly("payments", "error_rate", 81)]);
    expect(twice[0]?.score).toBe(once[0]?.score);
  });

  it("lists the repeat with weight 0 so the report still shows it", () => {
    const b = evidenceBuilder();
    const [first, repeat] = [b.anomaly("payments", "error_rate", 81), b.anomaly("payments", "error_rate", 81)];
    const [h] = rank([b.deploy("dep-1", "payments", 80), first, repeat]);
    expect(h?.for.find((l) => l.evidenceId === repeat.id)?.weight).toBe(0);
  });

  it("adds a bonus, not a second full count, when another source agrees", () => {
    const b = evidenceBuilder();
    const deploy = b.deploy("dep-1", "payments", 80);
    const alone = rank([deploy, b.anomaly("payments", "error_rate", 81)])[0]?.score ?? 0;
    const agreed = rank([deploy, b.anomaly("payments", "error_rate", 81), b.anomaly("payments", "error_rate", 81, "db-agent")])[0]?.score ?? 0;
    const anomalyWeight = 0.9;
    expect(agreed).toBeGreaterThan(alone);
    expect(agreed - alone).toBeCloseTo(anomalyWeight * 0.25);
  });
});

describe("mechanisms and topology", () => {
  it("counts a log that fits the cause's mechanism as strong support", () => {
    const b = evidenceBuilder();
    const ev = [b.deploy("dep-1", "payments", 80), b.anomaly("payments", "error_rate", 81)];
    const plain = rank(ev)[0]?.score ?? 0;
    const withLog = rank([...ev, b.log("payments", "ERROR", "TypeError: Cannot read properties of undefined", 81)])[0]?.score ?? 0;
    expect(withLog - plain).toBeCloseTo(1.5 * 0.75);
  });

  it("ignores a log explained by a different mechanism", () => {
    const b = evidenceBuilder();
    const log = b.log("payments", "ERROR", "could not extend file: No space left on device", 81);
    const [deploy] = rank([b.deploy("dep-1", "payments", 80), b.anomaly("payments", "error_rate", 81), log]).filter((h) => h.kind === "bad_deploy");
    expect([...(deploy?.for ?? []), ...(deploy?.against ?? [])].map((l) => l.evidenceId)).not.toContain(log.id);
  });

  it("counts logs that blame a dependency against causes in the caller", () => {
    const b = evidenceBuilder();
    const log = b.log("api", "ERROR", "upstream payments request failed: 503 Service Unavailable", 81);
    const hypotheses = rank([b.flag("api.banner", "api", 79), b.deploy("dep-1", "payments", 79), b.anomaly("payments", "error_rate", 80), log]);
    expect(byRef(hypotheses, "api.banner")?.against.map((l) => l.evidenceId)).toContain(log.id);
    expect(byRef(hypotheses, "dep-1")?.for.map((l) => l.evidenceId)).toContain(log.id);
  });

  it("counts normal metrics against a cause in a service with no anomalies", () => {
    const b = evidenceBuilder();
    const normal = b.normal("api", "error_rate");
    const api = byRef(rank([b.deploy("dep-api", "api", 80), b.anomaly("payments", "error_rate", 81), normal]), "dep-api");
    expect(api?.against.map((l) => l.evidenceId)).toContain(normal.id);
  });
});

describe("ranking", () => {
  const tied = (): { evidence: Evidence[]; candidates: Candidate[] } => {
    const b = evidenceBuilder();
    const evidence = [b.anomaly("payments", "error_rate", 81)];
    const candidate = (ref: string): Candidate => ({ kind: "external_dependency", service: "payments", ref, start: at(80), title: ref, origin: "rule" });
    return { evidence, candidates: [candidate("zeta-gw"), candidate("alpha-gw"), candidate("mid-gw")] };
  };

  it("breaks score ties by id", () => {
    const { evidence, candidates } = tied();
    expect(rank(evidence, candidates).map((h) => h.ref)).toEqual(["alpha-gw", "mid-gw", "zeta-gw"]);
  });

  it("produces the same order whatever order candidates arrive in", () => {
    const { evidence, candidates } = tied();
    expect(rank(evidence, [...candidates].reverse())).toEqual(rank(evidence, candidates));
  });

  it("numbers ranks from 1 and confidences sum to 1", () => {
    const b = evidenceBuilder();
    const hypotheses = rank([b.deploy("a", "payments", 80), b.deploy("b", "payments", 60), b.anomaly("payments", "error_rate", 81)]);
    expect(hypotheses.map((h) => h.rank)).toEqual([1, 2]);
    expect(hypotheses.reduce((s, h) => s + h.confidence, 0)).toBeCloseTo(1);
  });

  it("scores a duplicate candidate only once", () => {
    const b = evidenceBuilder();
    const evidence = [b.deploy("dep-1", "payments", 80), b.anomaly("payments", "error_rate", 81)];
    const candidates = ruleCandidates(ALERT, evidence);
    expect(rank(evidence, [...candidates, ...candidates])).toHaveLength(candidates.length);
  });
});

describe("untrusted text", () => {
  it("never weighs a suspicious instruction for or against anything", () => {
    const b = evidenceBuilder();
    const injection = b.injection("payments", 81);
    const evidence = [b.deploy("dep-1", "payments", 80), b.anomaly("payments", "error_rate", 81), injection];
    const resolution = resolveWith(ALERT, evidence, ruleCandidates(ALERT, evidence));
    expect(resolution.hypotheses).not.toHaveLength(0);
    const linked = resolution.hypotheses.flatMap((h) => [...h.for, ...h.against]).map((l) => l.evidenceId);
    expect(linked).not.toContain(injection.id);
    expect(resolution.ignored.map((i) => i.evidenceId)).toEqual([injection.id]);
  });
});
