import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { denyAll, type ApprovalCallback } from "../policy/approval.js";

/**
 * Ask the person at the terminal. Without a terminal (CI, pipes, MCP) there
 * is nobody to ask, so the answer is no: an unattended run can never approve
 * its own destructive action.
 */
export function terminalApprover(options: { input: Readable & { isTTY?: boolean }; output: Writable; approver: string }): ApprovalCallback {
  if (!options.input.isTTY) return denyAll;
  return async (request) => {
    const rl = createInterface({ input: options.input, output: options.output });
    try {
      options.output.write(
        `\nApproval needed: ${request.tool} (${request.tier}) as ${request.role}\n` +
          `  would: ${request.dryRun.summary}\n` +
          `  affects: ${request.dryRun.affectedServices.join(", ") || "nothing"}\n` +
          `  policy: ${request.reason}\n`,
      );
      const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      return { approved, approver: options.approver, note: approved ? "approved at terminal" : "declined at terminal" };
    } finally {
      rl.close();
    }
  };
}
