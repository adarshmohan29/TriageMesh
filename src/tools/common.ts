import { z } from "zod";
import { err, ok, type Result } from "../core/result.js";
import type { ToolError, ToolRunContext } from "../registry/tool.js";
import { MINUTE_MS } from "../sim/baseline.js";
import type { World } from "../sim/world.js";

/** Who the simulator records as the actor for actions TriageMesh takes. */
export const ACTOR = "triagemesh";

export const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Optional query window in epoch ms. Both ends default relative to the
 * world's clock, so a planner can omit them and get "the last hour".
 */
export const WindowInput = {
  from: z.number().int().optional().describe("Start, epoch ms. Default: 60 minutes before now."),
  to: z.number().int().optional().describe("End, epoch ms. Default: now."),
};

export function resolveWindow(
  world: World,
  input: { from?: number | undefined; to?: number | undefined },
): Result<{ from: number; to: number }, ToolError> {
  const to = input.to ?? world.now();
  const from = input.from ?? to - DEFAULT_WINDOW_MINUTES * MINUTE_MS;
  if (from > to) return err({ code: "invalid_input", message: `window start ${from} is after end ${to}` });
  return ok({ from, to });
}

/** The simulator is synchronous, so checking once before work is enough. */
export function checkAborted(ctx: ToolRunContext): Result<void, ToolError> {
  return ctx.signal?.aborted ? err({ code: "aborted", message: "aborted before start" }) : ok(undefined);
}
