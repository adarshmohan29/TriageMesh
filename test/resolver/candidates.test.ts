import { describe, expect, it } from "vitest";
import { hypothesisId, ruleCandidates } from "../../src/resolver/candidates.js";
import { blamedService, certificateOf, externalDependencyOf, mechanismsOf, reach } from "../../src/resolver/catalog.js";
import { ALERT, at, evidenceBuilder } from "./helpers.js";

describe("rule candidates", () => {
  it.each([
    ["code", "bad_deploy"],
    ["migration", "schema_migration"],
    ["config", "config_change"],
  ])("maps a %s deploy to %s", (changeType, kind) => {
    const b = evidenceBuilder();
    expect(ruleCandidates(ALERT, [b.deploy("dep-1", "payments", 80, changeType)])).toEqual([
      expect.objectContaining({ kind, service: "payments", ref: "dep-1", start: at(80), origin: "rule" }),
    ]);
  });

  it("maps a flag change to flag_change on the flag's service", () => {
    const b = evidenceBuilder();
    expect(ruleCandidates(ALERT, [b.flag("api.banner", "api", 70)])).toEqual([expect.objectContaining({ kind: "flag_change", service: "api", ref: "api.banner" })]);
  });

  it("points a memory leak at the last release before memory started climbing", () => {
    const b = evidenceBuilder();
    const evidence = [b.deploy("dep-old", "api", 5), b.deploy("dep-leak", "api", 14), b.anomaly("api", "mem_pct", 39), b.deploy("dep-later", "api", 60)];
    const leak = ruleCandidates(ALERT, evidence).find((c) => c.kind === "memory_leak");
    expect(leak).toMatchObject({ service: "api", ref: "dep-leak", start: at(39) });
  });

  it("starts a condition at its earliest sign", () => {
    const b = evidenceBuilder();
    const evidence = [b.anomaly("database", "disk_pct", 55), b.log("database", "WARN", "replication slot analytics_replica is inactive; retaining 12 GB of WAL", 30)];
    expect(ruleCandidates(ALERT, evidence)).toEqual([expect.objectContaining({ kind: "disk_full", start: at(30), ref: "analytics_replica" })]);
  });

  it("names an external dependency from the URL in a log", () => {
    const b = evidenceBuilder();
    const log = b.log("payments", "ERROR", "acquirer-gw timeout after 3000ms (POST https://acquirer-gw.example.net/v2/authorize)", 80);
    expect(ruleCandidates(ALERT, [log])).toEqual([expect.objectContaining({ kind: "external_dependency", service: "payments", ref: "acquirer-gw" })]);
  });

  it("builds ids from kind, service and ref", () => {
    expect(hypothesisId({ kind: "disk_full", service: "database" })).toBe("disk_full:database:-");
  });
});

describe("catalog", () => {
  it("does not treat our own services as external dependencies", () => {
    expect(externalDependencyOf("GET https://payments.internal/v1/charge")).toBeUndefined();
  });

  it("reads which dependency a log line blames", () => {
    expect(blamedService("upstream payments request failed: 503")).toBe("payments");
    expect(blamedService("TLS handshake with payments failed")).toBeUndefined();
  });

  it("reads the certificate name from an expiry error", () => {
    expect(certificateOf("certificate has expired (CN=api-client, notAfter=...)")).toBe("api-client");
  });

  it("classifies log lines by mechanism", () => {
    expect(mechanismsOf("container killed: OOMKilled")).toEqual(["memory"]);
    expect(mechanismsOf("GET /v1/checkout 200")).toEqual([]);
  });

  it("lets a cause reach its callers and direct dependency, not beyond", () => {
    expect(reach("database", "api")).toBe(0.6);
    expect(reach("payments", "database")).toBe(0.6);
    expect(reach("api", "database")).toBe(0);
  });
});
