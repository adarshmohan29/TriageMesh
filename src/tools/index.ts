import { ToolRegistry } from "../registry/registry.js";
import type { AnyTool } from "../registry/tool.js";
import type { World } from "../sim/world.js";
import { createReadTools } from "./read.js";
import { createWriteTools } from "./write.js";

/** Every tool, bound to one simulated world. */
export function createSimTools(world: World): AnyTool[] {
  return [...createReadTools(world), ...createWriteTools(world)];
}

export function createSimRegistry(world: World): ToolRegistry {
  return new ToolRegistry(createSimTools(world));
}
