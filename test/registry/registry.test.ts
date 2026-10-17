import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok } from "../../src/core/result.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { defineTool, type Capability, type Tier } from "../../src/registry/tool.js";

function tool(name: string, tier: Tier = "read", capability: Capability = "logs.read") {
  return defineTool({
    name,
    description: `test tool ${name}`,
    capabilities: [capability],
    tier,
    inputSchema: z.object({ n: z.number().default(1) }),
    outputSchema: z.object({}),
    async run() {
      return ok({});
    },
    async dryRun() {
      return ok({ summary: "", changes: [], affectedServices: [] });
    },
  });
}

describe("ToolRegistry", () => {
  it("throws on a duplicate name", () => {
    const registry = new ToolRegistry([tool("a.one")]);
    expect(() => registry.register(tool("a.one"))).toThrow(/duplicate/);
  });

  it("lists tools sorted by name", () => {
    const registry = new ToolRegistry([tool("z.last"), tool("a.first"), tool("m.mid")]);
    expect(registry.list().map((s) => s.name)).toEqual(["a.first", "m.mid", "z.last"]);
  });

  it("filters by capability", () => {
    const registry = new ToolRegistry([tool("a.logs"), tool("a.flags", "read", "flags.read")]);
    expect(registry.list({ capability: "flags.read" }).map((s) => s.name)).toEqual(["a.flags"]);
  });

  it("filters by tier", () => {
    const registry = new ToolRegistry([tool("a.read"), tool("a.write", "reversible_write"), tool("a.nuke", "destructive")]);
    expect(registry.list({ tiers: ["read", "reversible_write"] }).map((s) => s.name)).toEqual(["a.read", "a.write"]);
  });

  it("never exposes run through specs", () => {
    const spec = new ToolRegistry([tool("a.one")]).spec("a.one");
    expect(spec).toBeDefined();
    expect(spec).not.toHaveProperty("run");
    expect(spec).not.toHaveProperty("dryRun");
  });

  it("describes input as JSON Schema with defaulted fields optional", () => {
    const spec = new ToolRegistry([tool("a.one")]).spec("a.one");
    expect(spec?.inputJsonSchema).toMatchObject({ type: "object", properties: { n: { type: "number" } } });
    expect(spec?.inputJsonSchema.required ?? []).not.toContain("n");
  });

  it("returns undefined for an unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("no.such")).toBeUndefined();
    expect(registry.spec("no.such")).toBeUndefined();
  });
});
