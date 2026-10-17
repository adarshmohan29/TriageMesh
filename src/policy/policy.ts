import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";
import { TierSchema } from "../registry/tool.js";

/** Exact tool name ("db.drop_table") or a prefix wildcard ("db.*"). */
const ToolPatternSchema = z.string().regex(/^[a-z][a-z0-9_.]*(\.\*)?$|^\*$/, "expected a tool name, prefix.* or *");

// z.strictObject everywhere: a typo like `maxAffectedService` in a security
// config must fail loudly, not be silently ignored.
export const PolicyRuleSchema = z.strictObject({
  id: z.string().min(1),
  effect: z.enum(["deny", "require_approval"]),
  tools: z.array(ToolPatternSchema).min(1),
  /** Limit the rule to these roles; omitted = every role. */
  roles: z.array(z.string()).optional(),
  reason: z.string().min(1),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  roles: z.record(z.string(), z.strictObject({ tiers: z.array(TierSchema).min(1) })),
  rules: z.array(PolicyRuleSchema).default([]),
  limits: z.strictObject({
    /** Max services a single write may touch, per its dry run. */
    maxAffectedServices: z.number().int().min(1),
    /** Max successful writes per invoker (one invoker per investigation). */
    maxWritesPerRun: z.number().int().min(0),
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

export function parsePolicy(text: string): Result<Policy, string> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return err(`policy is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) return err(`invalid policy: ${z.prettifyError(parsed.error)}`);
  const ids = parsed.data.rules.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return err(`invalid policy: duplicate rule id "${dup}"`);
  return ok(parsed.data);
}

export function loadPolicyFile(path: string): Result<Policy, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return err(`cannot read policy file ${path}: ${(e as Error).message}`);
  }
  return parsePolicy(text);
}

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../policies/default.yaml", import.meta.url));
