import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/policy/policy.js";
import { defaultPolicy } from "./helpers.js";

const MINIMAL = `
version: 1
roles:
  investigator: { tiers: [read] }
limits: { maxAffectedServices: 1, maxWritesPerRun: 0 }
`;

describe("policy loader", () => {
  it("loads the shipped default policy", () => {
    const policy = defaultPolicy();
    expect(Object.keys(policy.roles)).toEqual(["investigator", "responder", "incident_commander"]);
  });

  it("defaults rules to an empty list", () => {
    const result = parsePolicy(MINIMAL);
    expect(result.ok && result.value.rules).toEqual([]);
  });

  it("rejects unknown keys so typos fail loudly", () => {
    const result = parsePolicy(MINIMAL.replace("maxWritesPerRun", "maxWritesPerRunn"));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown tier", () => {
    const result = parsePolicy(MINIMAL.replace("[read]", "[read, root]"));
    expect(result.ok).toBe(false);
  });

  it("rejects malformed YAML", () => {
    const result = parsePolicy("version: [1");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not valid YAML/) });
  });

  it("rejects duplicate rule ids", () => {
    const rule = "  - { id: r1, effect: deny, tools: [db.*], reason: x }\n";
    const result = parsePolicy(`${MINIMAL}rules:\n${rule}${rule}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/duplicate rule id "r1"/) });
  });
});
