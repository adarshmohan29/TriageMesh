import { parseArgs } from "node:util";
import { err, ok, type Result } from "../core/result.js";
import { DEFAULT_ROLE } from "../orchestrator/sim.js";

export interface InvestigateArgs {
  incident: string | undefined;
  role: string;
  seed: number;
  json: boolean;
  apply: boolean;
  /** Write the audit log here as JSONL. */
  audit: string | undefined;
  list: boolean;
  help: boolean;
}

export const INVESTIGATE_USAGE = `Usage: npm run investigate -- --incident <id> [options]

  --incident <id>   scripted incident to investigate (see --list)
  --role <role>     investigator | responder | incident_commander (default ${DEFAULT_ROLE})
  --seed <n>        simulator seed (default 1)
  --apply           run the recommended remediation (policy and approval still apply)
  --json            print the report as JSON instead of text
  --audit <path>    also append the audit log to this JSONL file
  --list            list incidents and exit
  -h, --help        show this help`;

/** Pure, so it can be tested without spawning the CLI. */
export function parseInvestigateArgs(argv: readonly string[]): Result<InvestigateArgs, string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        incident: { type: "string" },
        role: { type: "string", default: DEFAULT_ROLE },
        seed: { type: "string", default: "1" },
        json: { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        audit: { type: "string" },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  const seed = Number(v.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) return err(`--seed must be a non-negative integer, got "${v.seed}"`);
  if (!v.incident && !v.list && !v.help) return err("--incident is required");
  return ok({ incident: v.incident, role: v.role, seed, json: v.json, apply: v.apply, audit: v.audit, list: v.list, help: v.help });
}
