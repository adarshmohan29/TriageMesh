import type { DryRun, Tier } from "../registry/tool.js";

export interface ApprovalRequest {
  tool: string;
  tier: Tier;
  role: string;
  input: unknown;
  dryRun: DryRun;
  /** Why policy wants a human (rule id + reason). */
  reason: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Who decided, for the audit log. */
  approver: string;
  note?: string;
}

/** Asks a human (CLI prompt, chat message, ...). Must not be an LLM. */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** The safe default when nobody is around to ask. */
export const denyAll: ApprovalCallback = async () => ({
  approved: false,
  approver: "auto-deny",
  note: "no approver configured",
});
