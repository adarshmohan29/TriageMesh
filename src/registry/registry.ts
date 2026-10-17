import { z } from "zod";
import type { AnyTool, Capability, Tier } from "./tool.js";

/** What callers other than GuardedInvoker see: metadata, never `run`. */
export interface ToolSpec {
  name: string;
  description: string;
  capabilities: readonly Capability[];
  tier: Tier;
  /** JSON Schema of the accepted input, for LLM tool lists and the MCP server. */
  inputJsonSchema: Record<string, unknown>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /** Throws on a duplicate name: two tools answering to one name is a bug. */
  register(tool: AnyTool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * The full definition, including `run`. Only GuardedInvoker should use
   * this; everything else works from `spec()` / `list()`.
   */
  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  spec(name: string): ToolSpec | undefined {
    const tool = this.#tools.get(name);
    return tool && toSpec(tool);
  }

  /** All tools, sorted by name so listings (and LLM prompts) are stable. */
  list(filter: { capability?: Capability; tiers?: readonly Tier[] } = {}): ToolSpec[] {
    return [...this.#tools.values()]
      .filter(
        (t) =>
          (filter.capability === undefined || t.capabilities.includes(filter.capability)) &&
          (filter.tiers === undefined || filter.tiers.includes(t.tier)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toSpec);
  }
}

function toSpec(tool: AnyTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    capabilities: tool.capabilities,
    tier: tool.tier,
    // io: "input" describes what callers may send (defaulted fields optional).
    inputJsonSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>,
  };
}
