import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok } from "../../src/core/result.js";
import { defineTool } from "../../src/registry/tool.js";

const base = {
  name: "demo.echo",
  description: "Echo the input back unchanged.",
  capabilities: ["logs.read"] as const,
  tier: "read" as const,
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  async run(input: { text: string }) {
    return ok(input);
  },
};

describe("defineTool", () => {
  it("returns a valid definition unchanged", () => {
    expect(defineTool(base)).toBe(base);
  });

  it("rejects names that are not dotted lowercase", () => {
    expect(() => defineTool({ ...base, name: "Echo" })).toThrow(/dotted lowercase/);
  });

  it("rejects a tool with no capabilities", () => {
    expect(() => defineTool({ ...base, capabilities: [] })).toThrow(/demo\.echo/);
  });

  it("rejects a write tool without dryRun", () => {
    expect(() => defineTool({ ...base, tier: "reversible_write" })).toThrow(/must implement dryRun/);
  });

  it("rejects a destructive tool without dryRun", () => {
    expect(() => defineTool({ ...base, tier: "destructive" })).toThrow(/must implement dryRun/);
  });

  it("accepts a write tool with dryRun", () => {
    const dryRun = async () => ok({ summary: "nothing", changes: [], affectedServices: [] });
    expect(() => defineTool({ ...base, tier: "reversible_write", dryRun })).not.toThrow();
  });
});
