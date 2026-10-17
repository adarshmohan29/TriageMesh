import { SERVICES, type RootCauseKind, type Service } from "../sim/types.js";

/**
 * The resolver's domain knowledge, kept in one place: which failure
 * mechanisms a log line points at, which root-cause kinds can produce each
 * mechanism, and how trouble moves through api -> payments -> database.
 */

export type Mechanism = "code_error" | "cert" | "memory" | "disk" | "pool" | "query_plan" | "retry_load" | "external";

const MECHANISM_PATTERNS: [Mechanism, RegExp][] = [
  ["cert", /certificate (has expired|\S+ expires in)|renewed certificate/i],
  ["memory", /OOMKilled|out of memory|heap usage/i],
  ["disk", /No space left on device|retaining \S+ GB of WAL|disk (is )?full/i],
  ["pool", /acquiring connection from pool|pool exhausted/i],
  ["query_plan", /Seq Scan|slow query/i],
  ["retry_load", /retrying \(attempt|too many connections/i],
  ["code_error", /TypeError|ReferenceError|NullPointer|Exception\b|panic:|Cannot read properties/i],
];

/** Mechanisms each kind of root cause can produce. */
export const COMPATIBLE: Record<RootCauseKind, readonly Mechanism[]> = {
  bad_deploy: ["code_error"],
  flag_change: ["code_error", "retry_load"],
  config_change: ["pool", "retry_load"],
  schema_migration: ["query_plan"],
  external_dependency: ["external"],
  cert_expiry: ["cert"],
  memory_leak: ["memory"],
  disk_full: ["disk"],
};

/** Root causes that are a change record, as opposed to a condition that developed. */
export const CHANGE_KINDS: ReadonlySet<RootCauseKind> = new Set(["bad_deploy", "flag_change", "config_change", "schema_migration"]);

export function mechanismsOf(text: string): Mechanism[] {
  const found = MECHANISM_PATTERNS.filter(([, re]) => re.test(text)).map(([m]) => m);
  if (externalDependencyOf(text)) found.push("external");
  return found;
}

/**
 * A third-party dependency named in a log line: the first label of a URL
 * host, or the target of a circuit breaker, when it isn't one of ours.
 * "POST https://acquirer-gw.example.net/v2/authorize" -> "acquirer-gw".
 */
export function externalDependencyOf(text: string): string | undefined {
  const name = text.match(/https?:\/\/([a-z0-9-]+)\./i)?.[1] ?? text.match(/circuit breaker \S+ for ([a-z0-9-]+)/i)?.[1];
  return name && !isService(name) ? name : undefined;
}

/**
 * "upstream payments request failed" logged by api blames payments. The
 * service a log line blames is evidence the problem is there or deeper.
 */
export function blamedService(text: string): Service | undefined {
  const name = text.match(/\bupstream (\w+)/i)?.[1];
  return name && isService(name) ? name : undefined;
}

/** Specific refs a mechanism's log line names. */
export function certificateOf(text: string): string | undefined {
  // "...expired (CN=api-client, ..." or "wrote renewed certificate api-client to ...".
  return text.match(/CN=([a-z0-9-]+)/i)?.[1] ?? text.match(/certificate ([a-z0-9-]+) to\b/i)?.[1];
}

export function replicationSlotOf(text: string): string | undefined {
  return text.match(/replication slot (\w+)/i)?.[1];
}

function isService(name: string): name is Service {
  return (SERVICES as readonly string[]).includes(name);
}

// ---- Topology -------------------------------------------------------------
// SERVICES is ordered by request flow, so "callers" are earlier entries.

/** Everything that (transitively) calls `service`: its errors and latency surface there. */
export function callersOf(service: Service): Service[] {
  return SERVICES.slice(0, SERVICES.indexOf(service));
}

/** Everything `service` (transitively) depends on. */
export function dependenciesOf(service: Service): Service[] {
  return SERVICES.slice(SERVICES.indexOf(service) + 1);
}

/**
 * How strongly a cause in `root` can explain trouble seen in `observed`:
 * fully in its own service, partly in its callers (errors travel up), and
 * partly in its direct dependency (a misbehaving caller overloads it).
 * Zero elsewhere.
 */
export function reach(root: Service, observed: Service): number {
  if (observed === root) return 1;
  if (callersOf(root).includes(observed)) return 0.6;
  if (dependenciesOf(root)[0] === observed) return 0.6;
  return 0;
}
