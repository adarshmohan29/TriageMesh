import type { MockResponder } from "../llm/mock.js";
import { AlertSchema } from "../sim/types.js";
import { templateNeeds } from "./template.js";

interface ToolEntry {
  name: string;
}

/** Capability -> tool name in the simulator registry, as a model would infer from the tool list. */
const TOOL_FOR: Record<string, string> = {
  "status.read": "service.status",
  "deploys.read": "deploys.list",
  "flags.read": "flags.list",
  "config.read": "config.history",
  "metrics.read": "metrics.query",
  "logs.read": "logs.search",
};

/**
 * Offline stand-in for the planner LLM. It behaves like a focused model:
 * it investigates the alerting service and its dependencies but skips the
 * cheap status check, so the planner's "add missing core steps" path runs
 * on every mock investigation. Only tools present in the request are used.
 */
export const mockPlannerResponder: MockResponder = (request) => {
  const alert = AlertSchema.parse(request.data.find((d) => d.label === "alert")?.content);
  const offered = new Set(((request.data.find((d) => d.label === "tools")?.content ?? []) as ToolEntry[]).map((t) => t.name));

  const steps = templateNeeds(alert)
    .filter((need) => need.id !== "status")
    .flatMap((need) => {
      const tool = TOOL_FOR[need.capability];
      if (!tool || !offered.has(tool)) return [];
      return [{ id: need.id, tool, input: JSON.stringify(need.input), dependsOn: [], purpose: need.purpose }];
    });
  return { steps };
};
