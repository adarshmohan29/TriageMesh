import type { MockResponder } from "../llm/mock.js";
import { blamedService, certificateOf, externalDependencyOf, mechanismsOf, replicationSlotOf } from "../resolver/catalog.js";
import { MINUTE_MS } from "../sim/baseline.js";
import { AlertSchema, type Alert, type RootCauseKind, type Service } from "../sim/types.js";
import { ConfigHistoryOutputSchema, DeploysListOutputSchema, FlagsListOutputSchema, LogsSearchOutputSchema } from "../tools/read.js";
import type { BaselineAnswer, BaselineTurn, HistoryEntry } from "./react.js";

const CHANGE_LOOKBACK_MS = 180 * MINUTE_MS;
const LOG_LOOKBACK_MS = 30 * MINUTE_MS;
/** A change this close before the alert looks like "obviously the cause" to this agent. */
const SUSPICIOUS_CHANGE_MS = 15 * MINUTE_MS;
const MAX_LOG_HOPS = 3;

interface SeenChange {
  kind: RootCauseKind;
  service: Service;
  ref: string;
  at: number;
}

/**
 * Offline stand-in for the baseline's LLM: a plausible sequential agent,
 * scripted so the benchmark is reproducible. It does what many ReAct agents
 * do:
 *   1. list recent deploys, flag changes and config changes;
 *   2. if something changed in the 15 minutes before the alert, blame it and
 *      stop (it never checks whether the symptom started before the change);
 *   3. otherwise read the alerting service's logs, follow "upstream X"
 *      errors one hop at a time, and name the failure signature it finds.
 * Step 2 is its realistic weakness: it is fooled by a change that lands
 * just after the symptom began (upstream-gateway) or one that's unrelated
 * (cert-expiry). It never acts on instructions found in logs.
 */
export const mockBaselineResponder: MockResponder = (request) => {
  const alert = AlertSchema.parse(request.data.find((d) => d.label === "alert")?.content);
  const history = (request.data.find((d) => d.label === "history")?.content ?? []) as HistoryEntry[];
  return nextTurn(alert, history);
};

function nextTurn(alert: Alert, history: readonly HistoryEntry[]): BaselineTurn {
  const window = { from: alert.firedAt - CHANGE_LOOKBACK_MS, to: alert.firedAt };
  for (const tool of ["deploys.list", "flags.list", "config.history"]) {
    if (!history.some((h) => h.tool === tool)) return act(`Check what changed recently (${tool}).`, tool, window);
  }

  const changes = changesFrom(history).sort((a, b) => b.at - a.at || a.ref.localeCompare(b.ref));
  const recent = changes.filter((c) => c.at >= alert.firedAt - SUSPICIOUS_CHANGE_MS && c.at <= alert.firedAt);
  if (recent.length > 0) {
    const [first] = recent;
    return answer(`${first?.ref} landed ${minutesBefore(alert, first?.at ?? 0)}m before the alert; that is the likely cause.`, recent.map(asAnswer));
  }

  const logSteps = history.filter((h) => h.tool === "logs.search");
  const visited = logSteps.map((h) => (h.input as { service?: Service }).service);
  const lastLines = logSteps.length > 0 ? linesOf(logSteps[logSteps.length - 1]) : [];
  const next = logSteps.length === 0 ? alert.service : mostBlamed(lastLines, visited);
  if (next && logSteps.length < MAX_LOG_HOPS) {
    const why = logSteps.length === 0 ? "Read the alerting service's logs." : `Errors point at ${next}; read its logs.`;
    return act(why, "logs.search", { service: next, from: alert.firedAt - LOG_LOOKBACK_MS, to: alert.firedAt, limit: 1000 });
  }

  const deepest = visited.at(-1) ?? alert.service;
  const signature = signatureIn(lastLines, deepest, changes);
  const fallback = changes.slice(0, 3).map(asAnswer);
  if (signature) return answer(`The ${deepest} logs show ${signature.kind}.`, [signature, ...fallback].slice(0, 3));
  return answer("No clear signature; blaming the most recent changes.", fallback);
}

function changesFrom(history: readonly HistoryEntry[]): SeenChange[] {
  const out: SeenChange[] = [];
  for (const h of history) {
    if (h.tool === "deploys.list") {
      for (const d of DeploysListOutputSchema.safeParse(h.observation).data?.deploys ?? []) {
        const kind = d.changeType === "migration" ? "schema_migration" : d.changeType === "config" ? "config_change" : "bad_deploy";
        out.push({ kind, service: d.service, ref: d.id, at: d.t });
      }
    }
    if (h.tool === "flags.list") {
      for (const f of FlagsListOutputSchema.safeParse(h.observation).data?.changes ?? []) {
        out.push({ kind: "flag_change", service: ownerOf(f.flag), ref: f.flag, at: f.t });
      }
    }
    if (h.tool === "config.history") {
      for (const c of ConfigHistoryOutputSchema.safeParse(h.observation).data?.changes ?? []) {
        if (c.via === "config") out.push({ kind: "config_change", service: ownerOf(c.key), ref: c.key, at: c.t });
      }
    }
  }
  return out;
}

function linesOf(h: HistoryEntry | undefined): string[] {
  return LogsSearchOutputSchema.safeParse(h?.observation).data?.lines.map((l) => l.message) ?? [];
}

/** The dependency the logs blame most often that hasn't been read yet. */
function mostBlamed(lines: readonly string[], visited: readonly (Service | undefined)[]): Service | undefined {
  const counts = new Map<Service, number>();
  for (const line of lines) {
    const s = blamedService(line);
    if (s && !visited.includes(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function signatureIn(lines: readonly string[], service: Service, changes: readonly SeenChange[]): BaselineAnswer | undefined {
  const text = lines.join("\n");
  const has = (m: string) => lines.some((l) => mechanismsOf(l).includes(m as never));
  if (has("disk")) return { kind: "disk_full", service, ref: replicationSlotOf(text) ?? null };
  if (has("cert")) return { kind: "cert_expiry", service, ref: certificateOf(lines.find((l) => /CN=/.test(l)) ?? text) ?? null };
  if (has("memory")) return { kind: "memory_leak", service, ref: changes.find((c) => c.service === service && c.kind === "bad_deploy")?.ref ?? null };
  if (has("external")) return { kind: "external_dependency", service, ref: lines.map(externalDependencyOf).find(Boolean) ?? null };
  return undefined;
}

function ownerOf(key: string): Service {
  const prefix = key.split(".")[0];
  return prefix === "payments" || prefix === "database" ? prefix : "api";
}

function asAnswer(c: SeenChange): BaselineAnswer {
  return { kind: c.kind, service: c.service, ref: c.ref };
}

function minutesBefore(alert: Alert, t: number): number {
  return Math.round((alert.firedAt - t) / MINUTE_MS);
}

function act(thought: string, tool: string, input: Record<string, unknown>): BaselineTurn {
  return { thought, action: { tool, input: JSON.stringify(input) }, answer: null };
}

function answer(thought: string, answers: BaselineAnswer[]): BaselineTurn {
  return { thought, action: null, answer: answers.slice(0, 3) };
}
