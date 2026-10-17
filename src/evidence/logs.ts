import type { LogLine } from "../sim/types.js";

/**
 * Phrases typical of prompt injection. This is detection for the report,
 * not the defence: injected text can't do anything because the LLM only
 * sees logs inside data blocks and every action still passes policy.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /system override/i,
  /disregard (the|your|all) /i,
  /you are now /i,
  /\brun [a-z_]+\.[a-z_.]+ (with|immediately)/i,
];

export function detectInjection(message: string): string | undefined {
  for (const pattern of INJECTION_PATTERNS) {
    const match = message.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * Collapse a message to a template so repeats group together: numbers,
 * hex ids and quoted strings become placeholders.
 * "timeout after 3000ms (pool max=5)" -> "timeout after #ms (pool max=#)".
 */
export function logTemplate(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b[0-9a-f]{6,}\b/gi, "<id>")
    .replace(/\d+(\.\d+)?/g, "#")
    .slice(0, 200);
}

export interface LogGroup {
  template: string;
  level: LogLine["level"];
  lines: LogLine[];
}

/** INFO templates seen this often are routine traffic, not events. */
export const ROUTINE_INFO_THRESHOLD = 4;

/**
 * Group lines by (service, level, template). Keeps every WARN/ERROR group,
 * plus rare INFO groups: a one-off "renewed certificate" line can be the
 * key clue, while "GET /v1/checkout 200" every minute is noise.
 */
export function groupLogs(lines: readonly LogLine[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const line of lines) {
    const template = logTemplate(line.message);
    const key = `${line.service}|${line.level}|${template}`;
    const group = groups.get(key) ?? { template, level: line.level, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }
  return [...groups.values()].filter(
    (g) => g.level === "WARN" || g.level === "ERROR" || (g.level === "INFO" && g.lines.length < ROUTINE_INFO_THRESHOLD),
  );
}
