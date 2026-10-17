import { z } from "zod";
import type { Result } from "../core/result.js";

// ---- Metadata -------------------------------------------------------------

/**
 * Permission tier. The PolicyEngine (Phase 4) gates on this: reads run freely,
 * writes need a successful dryRun first, destructive actions also need approval.
 */
export const TierSchema = z.enum(["read", "reversible_write", "destructive"]);
export type Tier = z.infer<typeof TierSchema>;

/** What a tool can do. The router (Phase 5) shortlists tools by capability. */
export const CapabilitySchema = z.enum([
  "metrics.read",
  "logs.read",
  "deploys.read",
  "flags.read",
  "config.read",
  "status.read",
  "deploys.write",
  "flags.write",
  "service.write",
  "db.write",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/** Dotted lowercase names, e.g. "deploy.rollback", "db.pool.resize". */
const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const ToolMetaSchema = z.object({
  name: z.string().regex(TOOL_NAME, "tool names are dotted lowercase, e.g. deploy.rollback"),
  description: z.string().min(10),
  capabilities: z.array(CapabilitySchema).min(1),
  tier: TierSchema,
});

// ---- Run results ------------------------------------------------------------

export const ToolErrorSchema = z.object({
  code: z.enum(["invalid_input", "not_found", "conflict", "aborted", "failed"]),
  message: z.string(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * What a write would change, computed without changing anything. Policy reads
 * `affectedServices` to enforce blast-radius limits, so dry runs must be honest.
 */
export const DryRunSchema = z.object({
  summary: z.string(),
  changes: z.array(
    z.object({
      target: z.string(),
      from: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
  ),
  affectedServices: z.array(z.string()),
});
export type DryRun = z.infer<typeof DryRunSchema>;

export interface ToolRunContext {
  /** Aborted by the executor on timeout or when a hedged twin wins. */
  signal?: AbortSignal;
}

// ---- Definition -----------------------------------------------------------

/**
 * A tool. `run` and `dryRun` receive input already parsed by `inputSchema`;
 * their output is untrusted until checked against `outputSchema` (rule 2).
 *
 * Only GuardedInvoker may call `run`/`dryRun` (rule 1). Methods (not arrow
 * properties) are used so a specific tool is assignable to `AnyTool`.
 */
export interface ToolDefinition<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  capabilities: readonly Capability[];
  tier: Tier;
  inputSchema: In;
  outputSchema: Out;
  run(input: z.output<In>, ctx: ToolRunContext): Promise<Result<z.output<Out>, ToolError>>;
  dryRun?(input: z.output<In>, ctx: ToolRunContext): Promise<Result<DryRun, ToolError>>;
}

export type AnyTool = ToolDefinition<z.ZodType, z.ZodType>;

/**
 * Check a tool definition and return it unchanged. Mistakes here are
 * programmer errors, so this throws instead of returning a Result.
 */
export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  def: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  const meta = ToolMetaSchema.safeParse(def);
  if (!meta.success) {
    throw new Error(`defineTool(${def.name}): ${z.prettifyError(meta.error)}`);
  }
  // Rule 3 starts here: a write the policy can't preview can't be allowed.
  if (def.tier !== "read" && !def.dryRun) {
    throw new Error(`defineTool(${def.name}): ${def.tier} tools must implement dryRun`);
  }
  return def;
}
