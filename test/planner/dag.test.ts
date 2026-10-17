import { describe, expect, it } from "vitest";
import { dagIssues, levels } from "../../src/planner/dag.js";

const step = (id: string, ...dependsOn: string[]) => ({ id, dependsOn });

describe("levels", () => {
  it("puts independent steps in one level", () => {
    expect(levels([step("a"), step("b"), step("c")])).toEqual([["a", "b", "c"]]);
  });

  it("orders dependents after their dependencies", () => {
    expect(levels([step("c", "b"), step("b", "a"), step("a"), step("d", "a")])).toEqual([["a"], ["b", "d"], ["c"]]);
  });
});

describe("dagIssues", () => {
  it("accepts a valid DAG", () => {
    expect(dagIssues([step("a"), step("b", "a")])).toEqual([]);
  });

  it("reports duplicate ids", () => {
    expect(dagIssues([step("a"), step("a")])).toContain('duplicate step id "a"');
  });

  it("reports unknown dependencies", () => {
    expect(dagIssues([step("a", "ghost")])).toContain('step "a" depends on unknown step "ghost"');
  });

  it("reports self dependencies", () => {
    expect(dagIssues([step("a", "a")])).toContain('step "a" depends on itself');
  });

  it("reports cycles", () => {
    expect(dagIssues([step("a", "c"), step("b", "a"), step("c", "b"), step("d")])).toEqual(["dependencies contain a cycle"]);
  });
});
