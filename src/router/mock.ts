import type { MockResponder } from "../llm/mock.js";

interface Candidate {
  name: string;
  description: string;
}

/**
 * Offline stand-in for the router's LLM pick: choose the candidate whose name
 * and description share the most words with the goal (ties keep shortlist
 * order). Crude, but deterministic and good enough to route between, say,
 * db.failover and db.pool.resize from a goal that mentions "pool".
 */
export const mockRouterResponder: MockResponder = (request) => {
  const block = (label: string) => request.data.find((d) => d.label === label)?.content;
  const goal = words(String((block("request") as { goal?: unknown } | undefined)?.goal ?? ""));
  const candidates = (block("shortlist") ?? []) as Candidate[];

  let best: Candidate | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const score = [...words(`${c.name} ${c.description}`)].filter((w) => goal.has(w)).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return { tool: best?.name ?? "", reason: `mock: ${bestScore} words in common with the goal` };
};

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}
