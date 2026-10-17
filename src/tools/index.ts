import { ToolRegistry } from "../registry/registry.js";
import type { AnyTool } from "../registry/tool.js";
import type { World } from "../sim/world.js";
import { createReadTools, type ReadToolOptions } from "./read.js";
import { createWriteTools } from "./write.js";

/** Every tool, bound to one simulated world. */
export function createSimTools(world: World, options: ReadToolOptions = {}): AnyTool[] {
  return [...createReadTools(world, options), ...createWriteTools(world)];
}

export function createSimRegistry(world: World, options: ReadToolOptions = {}): ToolRegistry {
  return new ToolRegistry(createSimTools(world, options));
}
