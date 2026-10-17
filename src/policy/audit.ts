import { appendFileSync } from "node:fs";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { canonicalJson, sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";

export const GENESIS_HASH = "0".repeat(64);

/**
 * One decision or outcome. Every allow, deny, approval and result is logged,
 * including attempts that never reached the tool (rule 4).
 */
export const AuditEventSchema = z.object({
  kind: z.enum(["allow", "deny", "dry_run", "approval", "result"]),
  tool: z.string(),
  role: z.string(),
  input: z.unknown(),
  /** Why: the rule id or failure reason. */
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEntrySchema = AuditEventSchema.extend({
  seq: z.number().int().min(1),
  t: z.number().int(),
  prevHash: z.string().length(64),
  hash: z.string().length(64),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export interface AuditLogOptions {
  clock: Clock;
  /** Receives each entry as one JSONL line, e.g. fileSink(path). */
  sink?: (line: string) => void;
}

/**
 * Append-only, hash-chained log. Each entry's hash covers its content and the
 * previous entry's hash, so editing, deleting or reordering any entry breaks
 * verification of every entry after it. There is deliberately no API to
 * remove or modify an entry.
 */
export class AuditLog {
  readonly #clock: Clock;
  readonly #sink: ((line: string) => void) | undefined;
  readonly #entries: AuditEntry[] = [];

  constructor(options: AuditLogOptions) {
    this.#clock = options.clock;
    this.#sink = options.sink;
  }

  append(event: AuditEvent): AuditEntry {
    const prevHash = this.#entries.at(-1)?.hash ?? GENESIS_HASH;
    const body = { ...event, seq: this.#entries.length + 1, t: this.#clock.now(), prevHash };
    const entry: AuditEntry = Object.freeze({ ...body, hash: hashEntry(body) });
    this.#entries.push(entry);
    this.#sink?.(JSON.stringify(entry));
    return entry;
  }

  /** A copy, so callers can't splice the log. */
  entries(): AuditEntry[] {
    return [...this.#entries];
  }
}

export function fileSink(path: string): (line: string) => void {
  return (line) => appendFileSync(path, line + "\n");
}

export interface ChainError {
  seq: number;
  reason: string;
}

/** Check a log (in order, from the start) has not been tampered with. */
export function verifyAuditChain(entries: readonly AuditEntry[]): Result<void, ChainError> {
  let prevHash = GENESIS_HASH;
  for (const [i, entry] of entries.entries()) {
    const { hash, ...body } = entry;
    if (entry.seq !== i + 1) return err({ seq: entry.seq, reason: `expected seq ${i + 1}` });
    if (entry.prevHash !== prevHash) return err({ seq: entry.seq, reason: "prevHash does not match previous entry" });
    if (hashEntry(body) !== hash) return err({ seq: entry.seq, reason: "hash does not match content" });
    prevHash = hash;
  }
  return ok(undefined);
}

/** Parse a JSONL audit file. Malformed lines are reported, not skipped. */
export function parseAuditJsonl(text: string): Result<AuditEntry[], ChainError> {
  const entries: AuditEntry[] = [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (const [i, line] of lines.entries()) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return err({ seq: i + 1, reason: "line is not valid JSON" });
    }
    const parsed = AuditEntrySchema.safeParse(json);
    if (!parsed.success) return err({ seq: i + 1, reason: z.prettifyError(parsed.error) });
    entries.push(parsed.data);
  }
  return ok(entries);
}

function hashEntry(body: Omit<AuditEntry, "hash">): string {
  return sha256(canonicalJson(body));
}
