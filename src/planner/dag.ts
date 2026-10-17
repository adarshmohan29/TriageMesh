import type { Step } from "./plan.js";

/**
 * Structural problems: duplicate ids, unknown or self dependencies, cycles.
 * Returns every problem found rather than the first, for better fallback notes.
 */
export function dagIssues(steps: readonly Pick<Step, "id" | "dependsOn">[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) issues.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) issues.push(`step "${step.id}" depends on itself`);
      else if (!ids.has(dep)) issues.push(`step "${step.id}" depends on unknown step "${dep}"`);
    }
  }
  if (issues.length === 0 && levels(steps).flat().length < steps.length) {
    issues.push("dependencies contain a cycle");
  }
  return issues;
}

/**
 * Kahn's algorithm, grouped: level 0 has no dependencies, level n depends
 * only on earlier levels. Steps within a level can run in parallel. Steps on
 * a cycle never reach in-degree 0 and are left out (dagIssues uses that).
 */
export function levels(steps: readonly Pick<Step, "id" | "dependsOn">[]): string[][] {
  const remaining = new Map(steps.map((s) => [s.id, new Set(s.dependsOn)]));
  const out: string[][] = [];
  for (;;) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) return out;
    out.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
}
