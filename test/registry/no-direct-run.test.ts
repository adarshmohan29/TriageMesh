import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rule 1 in code: only the policy layer (GuardedInvoker) may call a tool's
 * run() or dryRun(). This scans src/ so a shortcut fails CI instead of
 * relying on review to catch it.
 */
const SRC = join(import.meta.dirname, "../../src");
const ALLOWED_DIR = "policy/";
const DIRECT_CALL = /\.(run|dryRun)\s*\(/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("tool invocation boundary", () => {
  it("has no run()/dryRun() calls outside src/policy", () => {
    const offenders = tsFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((rel) => !rel.startsWith(ALLOWED_DIR))
      .flatMap((rel) =>
        readFileSync(join(SRC, rel), "utf8")
          .split("\n")
          .flatMap((line, i) => (DIRECT_CALL.test(line) ? [`src/${rel}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(offenders).toEqual([]);
  });
});
