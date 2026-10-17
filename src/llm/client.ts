import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";

/** What a call is for. MockLlm dispatches on it; logs and tests key on it. */
export const LlmPurposeSchema = z.enum(["router.pick", "planner.plan", "resolver.hypotheses", "remediation.propose", "baseline.step"]);
export type LlmPurpose = z.infer<typeof LlmPurposeSchema>;

/**
 * Input the model should read but never obey: tool output, alert text, tool
 * descriptions. Rendered inside a delimited block (see untrusted.ts).
 */
export interface DataBlock {
  /** Lowercase identifier, e.g. "shortlist", "alert". */
  label: string;
  content: unknown;
}

export interface LlmRequest<T> {
  purpose: LlmPurpose;
  /** Trusted text we wrote. Never interpolate tool output into it (rule 2). */
  instruction: string;
  data: DataBlock[];
  /** The reply must parse as this; anything else is an `invalid_output` error. */
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LlmError {
  code: "unavailable" | "refused" | "truncated" | "invalid_output" | "aborted";
  message: string;
}

export interface LlmCallOptions {
  signal?: AbortSignal;
}

/**
 * The LLM proposes; code decides (rule 7). Every reply is validated against
 * the request's schema before the caller sees it, and every caller must have
 * a deterministic fallback for the error branch.
 */
export interface LlmClient {
  readonly name: string;
  generate<T>(request: LlmRequest<T>, options?: LlmCallOptions): Promise<Result<T, LlmError>>;
}

/** Shared by every client so validation can't be skipped by one of them. */
export function validateReply<T>(schema: z.ZodType<T>, raw: unknown): Result<T, LlmError> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err({ code: "invalid_output", message: z.prettifyError(parsed.error) });
}
