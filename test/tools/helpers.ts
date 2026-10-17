import type { Result } from "../../src/core/result.js";
import type { AnyTool, DryRun, ToolError } from "../../src/registry/tool.js";
import { createSimRegistry } from "../../src/tools/index.js";
import type { World } from "../../src/sim/world.js";

/**
 * Calls a tool the way GuardedInvoker will: parse input, run, validate output.
 * Tests may call run() directly; src/ may not (see no-direct-run.test.ts).
 */
export async function invoke(
  world: World,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<Result<any, ToolError>> {
  const tool = getTool(world, name);
  const result = await tool.run(tool.inputSchema.parse(input), signal ? { signal } : {});
  if (result.ok) tool.outputSchema.parse(result.value);
  return result;
}

export async function dryRun(world: World, name: string, input: unknown): Promise<Result<DryRun, ToolError>> {
  const tool = getTool(world, name);
  if (!tool.dryRun) throw new Error(`${name} has no dryRun`);
  return tool.dryRun(tool.inputSchema.parse(input), {});
}

export function getTool(world: World, name: string): AnyTool {
  const tool = createSimRegistry(world).get(name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool;
}
