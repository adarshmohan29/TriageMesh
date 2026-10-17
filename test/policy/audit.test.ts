import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { canonicalJson } from "../../src/core/hash.js";
import { unwrap } from "../../src/core/result.js";
import { AuditLog, GENESIS_HASH, parseAuditJsonl, verifyAuditChain, type AuditEntry } from "../../src/policy/audit.js";

function logWith(n: number, sink?: (line: string) => void): AuditLog {
  const log = new AuditLog({ clock: new VirtualClock(1_000), ...(sink && { sink }) });
  for (let i = 0; i < n; i++) {
    log.append({ kind: "allow", tool: "logs.search", role: "investigator", input: { i }, reason: "ok" });
  }
  return log;
}

describe("AuditLog", () => {
  it("chains each entry to the previous one", () => {
    const [a, b] = logWith(2).entries();
    expect(a?.prevHash).toBe(GENESIS_HASH);
    expect(b?.prevHash).toBe(a?.hash);
  });

  it("stamps entries with the injected clock", () => {
    expect(logWith(1).entries()[0]?.t).toBe(1_000);
  });

  it("verifies an untouched chain", () => {
    expect(verifyAuditChain(logWith(5).entries()).ok).toBe(true);
  });

  it("detects an edited entry", () => {
    const entries = logWith(3).entries();
    entries[1] = { ...entries[1], input: { i: 99 } } as AuditEntry;
    expect(verifyAuditChain(entries)).toMatchObject({ ok: false, error: { seq: 2 } });
  });

  it("detects a deleted entry", () => {
    const entries = logWith(3).entries();
    entries.splice(1, 1);
    expect(verifyAuditChain(entries).ok).toBe(false);
  });

  it("detects reordered entries", () => {
    const [a, b, c] = logWith(3).entries() as [AuditEntry, AuditEntry, AuditEntry];
    expect(verifyAuditChain([a, c, b]).ok).toBe(false);
  });

  it("does not let callers modify the log through entries()", () => {
    const log = logWith(2);
    log.entries().pop();
    expect(log.entries()).toHaveLength(2);
  });

  it("writes JSONL that parses back into a valid chain", () => {
    const lines: string[] = [];
    logWith(4, (line) => lines.push(line));
    const parsed = unwrap(parseAuditJsonl(lines.join("\n")));
    expect(parsed).toHaveLength(4);
    expect(verifyAuditChain(parsed).ok).toBe(true);
  });

  it("reports a malformed JSONL line", () => {
    expect(parseAuditJsonl("{not json")).toMatchObject({ ok: false, error: { seq: 1 } });
  });
});

describe("canonicalJson", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
