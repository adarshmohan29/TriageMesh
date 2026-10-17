import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";
import type { ToolRegistry } from "../registry/registry.js";
import { DryRunSchema, type AnyTool, type DryRun, type Tier, type ToolError } from "../registry/tool.js";
import type { ApprovalCallback } from "./approval.js";
import type { AuditEvent, AuditLog } from "./audit.js";
import type { Decision, PolicyEngine } from "./engine.js";

export const InvokeErrorSchema = z.object({
  code: z.enum([
    "unknown_tool",
    "invalid_input",
    "denied",
    "dry_run_failed",
    "not_approved",
    "tool_error",
    "invalid_output",
  ]),
  tool: z.string(),
  message: z.string(),
  /** The tool's own error, when it returned one. */
  cause: z.custom<ToolError>().optional(),
});
export type InvokeError = z.infer<typeof InvokeErrorSchema>;

export interface InvokeOptions {
  role: string;
  signal?: AbortSignal;
}

export interface InvokeSuccess {
  output: unknown;
  /** Present for writes: what the dry run said would change. */
  dryRun?: DryRun;
}

/** What a write would do, and what policy would say, without doing it. */
export interface PreviewResult {
  tier: Tier;
  dryRun: DryRun;
  /** Policy would allow it, but only once a human approves. */
  requiresApproval: boolean;
  reason: string;
}

export interface GuardedInvokerDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLog;
  approve: ApprovalCallback;
}

/**
 * The single door to every tool (rule 1). In order:
 *   look up -> validate input -> policy check -> [dryRun -> limits -> approval] -> run -> validate output
 * and every decision along the way lands in the audit log, denials included.
 *
 * One invoker per investigation: it counts writes for `maxWritesPerRun`.
 */
export class GuardedInvoker {
  readonly #deps: GuardedInvokerDeps;
  #writes = 0;

  constructor(deps: GuardedInvokerDeps) {
    this.#deps = deps;
  }

  get writeCount(): number {
    return this.#writes;
  }

  async invoke(name: string, rawInput: unknown, options: InvokeOptions): Promise<Result<InvokeSuccess, InvokeError>> {
    const { role } = options;
    const ctx = options.signal ? { signal: options.signal } : {};

    const admitted = this.#admit(name, rawInput, role);
    if (!admitted.ok) return admitted;
    const { tool, input, call } = admitted.value;

    let dryRun: DryRun | undefined;
    if (tool.tier !== "read") {
      const gated = await this.#gateWrite(tool, input, role, ctx);
      if (!gated.ok) return gated;
      dryRun = gated.value;
    } else {
      this.#audit({ kind: "allow", tool: name, role, input, reason: call.reason });
    }

    return this.#run(tool, input, role, ctx, dryRun);
  }

  /**
   * The write path up to (not including) approval, for showing a proposed
   * remediation: validate input -> policy -> dryRun -> limits. It never asks
   * a human and never runs the tool, and is audited like any other decision.
   */
  async preview(name: string, rawInput: unknown, options: InvokeOptions): Promise<Result<PreviewResult, InvokeError>> {
    const { role } = options;
    const admitted = this.#admit(name, rawInput, role);
    if (!admitted.ok) return admitted;
    const { tool, input } = admitted.value;
    if (tool.tier === "read") {
      return this.#fail({ kind: "deny", tool: name, role, input, reason: "preview is only for write tools" }, "invalid_input");
    }
    const checked = await this.#dryRunWithinLimits(tool, input, role, options.signal ? { signal: options.signal } : {}, true);
    if (!checked.ok) return checked;
    const { dryRun, limits } = checked.value;
    return ok({ tier: tool.tier, dryRun, requiresApproval: limits.requiresApproval, reason: limits.reason });
  }

  /** Look up -> validate input -> may this role call this tool at all? */
  #admit(name: string, rawInput: unknown, role: string): Result<{ tool: AnyTool; input: unknown; call: Decision & { allowed: true } }, InvokeError> {
    const tool = this.#deps.registry.get(name);
    if (!tool) {
      return this.#fail({ kind: "deny", tool: name, role, input: rawInput, reason: "unknown tool" }, "unknown_tool");
    }
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const reason = `invalid input: ${z.prettifyError(parsed.error)}`;
      return this.#fail({ kind: "deny", tool: name, role, input: rawInput, reason }, "invalid_input");
    }
    const input: unknown = parsed.data;
    const call = this.#deps.policy.checkCall({ tool, role });
    if (!call.allowed) return this.#fail({ kind: "deny", tool: name, role, input, reason: call.reason }, "denied");
    return ok({ tool, input, call });
  }

  /** Rule 3: a successful dry run, blast-radius limits, then approval if required. */
  async #gateWrite(
    tool: AnyTool,
    input: unknown,
    role: string,
    ctx: { signal?: AbortSignal },
  ): Promise<Result<DryRun, InvokeError>> {
    const name = tool.name;
    const checked = await this.#dryRunWithinLimits(tool, input, role, ctx, false);
    if (!checked.ok) return checked;
    const { dryRun, limits } = checked.value;

    if (limits.requiresApproval) {
      const decision = await this.#deps.approve({ tool: name, tier: tool.tier, role, input, dryRun, reason: limits.reason });
      this.#audit({
        kind: "approval",
        tool: name,
        role,
        input,
        reason: limits.reason,
        detail: { approved: decision.approved, approver: decision.approver, ...(decision.note && { note: decision.note }) },
      });
      if (!decision.approved) {
        return err({ code: "not_approved", tool: name, message: `${decision.approver} did not approve ${name}` });
      }
    }
    this.#audit({ kind: "allow", tool: name, role, input, reason: limits.reason });
    return ok(dryRun);
  }

  /** Dry run, then the limits that depend on what it would change. */
  async #dryRunWithinLimits(
    tool: AnyTool,
    input: unknown,
    role: string,
    ctx: { signal?: AbortSignal },
    isPreview: boolean,
  ): Promise<Result<{ dryRun: DryRun; limits: Decision & { allowed: true } }, InvokeError>> {
    const name = tool.name;
    // defineTool guarantees dryRun on writes; this guards hand-built tools too.
    const dryRunFn = tool.dryRun?.bind(tool);
    if (!dryRunFn) {
      return this.#fail({ kind: "deny", tool: name, role, input, reason: "write tool has no dryRun" }, "dry_run_failed");
    }
    const preview = await guard(() => dryRunFn(input, ctx));
    if (!preview.ok) {
      return this.#fail(
        { kind: "deny", tool: name, role, input, reason: `dry run failed: ${preview.error.message}` },
        "dry_run_failed",
        preview.error,
      );
    }
    const dryRunParsed = DryRunSchema.safeParse(preview.value);
    if (!dryRunParsed.success) {
      return this.#fail({ kind: "deny", tool: name, role, input, reason: "dry run returned malformed output" }, "dry_run_failed");
    }
    const dryRun = dryRunParsed.data;

    const limits = this.#deps.policy.checkDryRun({ tool, role, dryRun, writesSoFar: this.#writes });
    if (!limits.allowed) {
      return this.#fail({ kind: "deny", tool: name, role, input, reason: limits.reason, detail: { dryRun } }, "denied");
    }
    this.#audit({ kind: "dry_run", tool: name, role, input, reason: dryRun.summary, detail: { dryRun, ...(isPreview && { preview: true }) } });
    return ok({ dryRun, limits });
  }

  async #run(
    tool: AnyTool,
    input: unknown,
    role: string,
    ctx: { signal?: AbortSignal },
    dryRun: DryRun | undefined,
  ): Promise<Result<InvokeSuccess, InvokeError>> {
    const name = tool.name;
    const result = await guard(() => tool.run(input, ctx));
    if (!result.ok) {
      this.#audit({ kind: "result", tool: name, role, input, reason: `error: ${result.error.message}`, detail: { code: result.error.code } });
      return err({ code: "tool_error", tool: name, message: result.error.message, cause: result.error });
    }

    // Rule 2: output is untrusted until it matches the declared schema.
    const output = tool.outputSchema.safeParse(result.value);
    if (!output.success) {
      this.#audit({ kind: "result", tool: name, role, input, reason: "output failed schema validation" });
      return err({ code: "invalid_output", tool: name, message: z.prettifyError(output.error) });
    }

    if (tool.tier !== "read") this.#writes++;
    this.#audit({ kind: "result", tool: name, role, input, reason: "ok" });
    return ok(dryRun ? { output: output.data, dryRun } : { output: output.data });
  }

  #audit(event: AuditEvent): void {
    this.#deps.audit.append(event);
  }

  #fail(event: AuditEvent, code: InvokeError["code"], cause?: ToolError): Result<never, InvokeError> {
    this.#audit(event);
    return err({ code, tool: event.tool, message: event.reason, ...(cause && { cause }) });
  }
}

/**
 * A tool that throws (instead of returning a Result) has a bug, but one buggy
 * tool shouldn't take down a whole investigation, so it becomes a ToolError.
 */
async function guard<T>(fn: () => Promise<Result<T, ToolError>>): Promise<Result<T, ToolError>> {
  try {
    return await fn();
  } catch (e) {
    return err({ code: "failed", message: `tool threw: ${e instanceof Error ? e.message : String(e)}` });
  }
}
