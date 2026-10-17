import { z } from "zod";
import { canonicalJson } from "../core/hash.js";
import { createIdGenerator } from "../core/ids.js";
import type { Evidence } from "../evidence/schema.js";
import type { ExecutionResult } from "../executor/executor.js";
import type { LlmClient } from "../llm/client.js";
import type { GuardedInvoker, InvokeError, PreviewResult } from "../policy/invoker.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { Hypothesis, Resolution } from "../resolver/schema.js";
import { ConfigHistoryOutputSchema, FlagsListOutputSchema, ServiceStatusOutputSchema } from "../tools/read.js";
import { DB_HOSTS } from "../tools/write.js";
import type { Alert } from "../sim/types.js";
import type { RemediationProposal } from "./report.js";

/** Hypotheses worth proposing fixes for. */
const TOP_HYPOTHESES = 3;
const MAX_LLM_PROPOSALS = 5;
const POOL_KEY = "payments.db_pool_max";

/** Current state as the investigation observed it (tool output, schema-checked). */
export interface Facts {
  flags: Record<string, boolean>;
  config: Record<string, unknown>;
  dbPrimary: string | undefined;
}

interface Action {
  tool: string;
  input: Record<string, unknown>;
  rationale: string;
  effect: "fix" | "mitigation";
}

export interface ProposeDeps {
  invoker: GuardedInvoker;
  registry: ToolRegistry;
  llm: LlmClient;
}

export interface ProposeOptions {
  role: string;
  signal?: AbortSignal;
}

/** Read the latest flags, config and db primary out of the executed steps. */
export function factsFrom(execution: ExecutionResult): Facts {
  const facts: Facts = { flags: {}, config: {}, dbPrimary: undefined };
  for (const step of execution.steps) {
    if (step.status !== "ok") continue;
    if (step.tool === "flags.list") {
      const out = FlagsListOutputSchema.safeParse(step.output);
      if (out.success) Object.assign(facts.flags, out.data.current);
    }
    if (step.tool === "config.history") {
      const out = ConfigHistoryOutputSchema.safeParse(step.output);
      if (out.success) Object.assign(facts.config, out.data.current);
    }
    if (step.tool === "service.status") {
      const out = ServiceStatusOutputSchema.safeParse(step.output);
      if (out.success) facts.dbPrimary = out.data.dbPrimary;
    }
  }
  return facts;
}

/**
 * The remediation catalog: what fixes each kind of root cause, worked out
 * from the hypothesis and what the investigation saw. Pure.
 */
export function catalogActions(h: Hypothesis, evidence: readonly Evidence[], facts: Facts): Action[] {
  const change = findChange(evidence, h.ref);
  const rollback = (why: string): Action => ({ tool: "deploy.rollback", input: { service: h.service }, rationale: why, effect: "fix" });

  switch (h.kind) {
    case "bad_deploy":
    case "schema_migration":
      return [rollback(`roll back ${h.ref ?? h.service} to the previous version`)];
    case "config_change":
      if (change?.subject.type === "deploy") return [rollback(`roll back config deploy ${h.ref}`)];
      if (h.ref === POOL_KEY && typeof change?.value.from === "number") {
        return [{ tool: "db.pool.resize", input: { service: "payments", size: change.value.from }, rationale: `restore ${POOL_KEY} to ${change.value.from}`, effect: "fix" }];
      }
      return [];
    case "flag_change": {
      if (!h.ref) return [];
      const previous = typeof change?.value.from === "boolean" ? change.value.from : facts.flags[h.ref] === undefined ? undefined : !facts.flags[h.ref];
      if (previous === undefined) return [];
      return [{ tool: "flags.set", input: { flag: h.ref, enabled: previous }, rationale: `set ${h.ref} back to ${previous ? "on" : "off"}`, effect: "fix" }];
    }
    case "memory_leak":
      return [
        ...(h.ref ? [rollback(`roll back ${h.ref}, the release that leaks`)] : []),
        { tool: "service.restart", input: { service: h.service }, rationale: "restart frees the leaked memory, until it leaks again", effect: "mitigation" },
      ];
    case "cert_expiry":
      return [{ tool: "service.restart", input: { service: h.service }, rationale: "restart loads the renewed certificate from disk", effect: "fix" }];
    case "external_dependency":
      // Our side can only route around it: turn on the service's fallback flag if it has one.
      return Object.entries(facts.flags)
        .filter(([flag, on]) => !on && flag.startsWith(`${h.service}.`) && flag.includes("fallback"))
        .map(([flag]) => ({ tool: "flags.set", input: { flag, enabled: true }, rationale: `route ${h.service} around ${h.ref ?? "the dependency"} via ${flag}`, effect: "fix" as const }));
    case "disk_full": {
      const target = DB_HOSTS.find((host) => facts.dbPrimary !== undefined && host !== facts.dbPrimary);
      return target ? [{ tool: "db.failover", input: { to: target }, rationale: `promote ${target}, whose disk isn't full`, effect: "fix" }] : [];
    }
  }
}

/**
 * Propose remediations for the top hypotheses. Each one is previewed through
 * GuardedInvoker (dry run + policy, audited) and nothing is executed. The
 * LLM may add suggestions; they get the same preview, so policy (not the
 * model) decides whether they could run, and they are never recommended.
 */
export async function proposeRemediations(
  alert: Alert,
  resolution: Resolution,
  evidence: readonly Evidence[],
  facts: Facts,
  deps: ProposeDeps,
  options: ProposeOptions,
): Promise<{ proposals: RemediationProposal[]; notes: string[] }> {
  const ids = createIdGenerator();
  const notes: string[] = [];
  const proposals: RemediationProposal[] = [];
  const top = resolution.hypotheses.filter((h) => h.score > 0).slice(0, TOP_HYPOTHESES);

  for (const h of top) {
    const actions = catalogActions(h, evidence, facts);
    if (actions.length === 0) notes.push(`no automated remediation for ${h.id}; needs a human`);
    for (const action of actions) {
      // Two hypotheses can share a fix (a leak and its release both mean "roll back").
      if (alreadyProposed(proposals, action)) continue;
      proposals.push(await previewed(ids.next("rem"), h, action, "catalog", deps.invoker, options));
    }
  }

  const suggested = await suggest(alert, top, deps, options);
  notes.push(...suggested.notes);
  for (const { hypothesis, action } of suggested.actions) {
    if (alreadyProposed(proposals, action)) continue;
    proposals.push(await previewed(ids.next("rem"), hypothesis, action, "llm", deps.invoker, options));
  }

  // Only a catalog fix for the leading hypothesis that policy would allow
  // and whose dry run matches the hypothesis. Never a model's suggestion.
  const leader = top[0];
  const best = proposals.find(
    (p) =>
      p.hypothesisId === leader?.id &&
      p.origin === "catalog" &&
      p.effect === "fix" &&
      p.warnings.length === 0 &&
      (p.decision.status === "allowed" || p.decision.status === "needs_approval"),
  );
  if (best) best.recommended = true;
  else if (leader) notes.push(`nothing to recommend for ${leader.id} with role ${options.role}`);
  return { proposals, notes };
}

async function previewed(
  id: string,
  h: Hypothesis,
  action: Action,
  origin: RemediationProposal["origin"],
  invoker: GuardedInvoker,
  options: ProposeOptions,
): Promise<RemediationProposal> {
  const result = await invoker.preview(action.tool, action.input, options.signal ? { role: options.role, signal: options.signal } : { role: options.role });
  const base = { id, hypothesisId: h.id, tool: action.tool, input: action.input, rationale: action.rationale, origin, effect: action.effect, recommended: false };
  if (!result.ok) return { ...base, tier: null, preview: null, decision: refused(result.error), warnings: [] };
  return { ...base, tier: result.value.tier, preview: result.value.dryRun, decision: approved(result.value), warnings: fitWarnings(h, action, result.value) };
}

function approved(p: PreviewResult): RemediationProposal["decision"] {
  return p.requiresApproval ? { status: "needs_approval", reason: p.reason } : { status: "allowed", reason: p.reason };
}

function refused(e: InvokeError): RemediationProposal["decision"] {
  const status = e.code === "denied" ? "denied" : e.code === "dry_run_failed" ? "dry_run_failed" : "invalid";
  return { status, reason: e.message };
}

/** Does the dry run actually do what the hypothesis needs? */
function fitWarnings(h: Hypothesis, action: Action, p: PreviewResult): string[] {
  const warnings: string[] = [];
  // Rollback undoes the *latest* deploy; if that isn't the suspect, it's the wrong fix.
  if (action.tool === "deploy.rollback" && h.ref && !p.dryRun.summary.includes(h.ref)) {
    warnings.push(`rollback would undo a different deploy than ${h.ref}: ${p.dryRun.summary}`);
  }
  if (p.dryRun.changes.length === 0) warnings.push(`no-op: ${p.dryRun.summary}`);
  return warnings;
}

function alreadyProposed(proposals: readonly RemediationProposal[], action: Action): boolean {
  return proposals.some((p) => p.tool === action.tool && canonicalJson(p.input) === canonicalJson(action.input));
}

function findChange(evidence: readonly Evidence[], ref: string | undefined) {
  for (const e of evidence) if (e.claim.kind === "change" && e.claim.subject.ref === ref) return e.claim;
  return undefined;
}

// ---- LLM suggestions -----------------------------------------------------------

const SuggestionsSchema = z.object({
  remediations: z
    .array(
      z.object({
        hypothesisId: z.string(),
        tool: z.string(),
        /** JSON object string; parsed and validated by code. */
        input: z.string(),
        rationale: z.string(),
      }),
    )
    .max(10),
});

async function suggest(
  alert: Alert,
  top: readonly Hypothesis[],
  deps: ProposeDeps,
  options: ProposeOptions,
): Promise<{ actions: { hypothesis: Hypothesis; action: Action }[]; notes: string[] }> {
  if (top.length === 0) return { actions: [], notes: [] };
  const tools = deps.registry
    .list()
    .filter((t) => t.tier !== "read")
    .map(({ name, description, tier, inputJsonSchema }) => ({ name, description, tier, inputJsonSchema }));

  const reply = await deps.llm.generate(
    {
      purpose: "remediation.propose",
      instruction:
        "Suggest remediations for the hypotheses using only the listed tools. Each input is a JSON " +
        "object string matching that tool's schema. Every suggestion is dry-run and checked against " +
        "policy before anyone can run it. Return an empty list if you have nothing to add.",
      data: [
        { label: "alert", content: alert },
        { label: "hypotheses", content: top.map(({ id, kind, service, ref, title, score }) => ({ id, kind, service, ref: ref ?? null, title, score })) },
        { label: "tools", content: tools },
      ],
      schema: SuggestionsSchema,
    },
    options.signal ? { signal: options.signal } : {},
  );
  if (!reply.ok) return { actions: [], notes: [`catalog remediations only: LLM ${reply.error.code}: ${reply.error.message}`] };

  const notes: string[] = [];
  const actions: { hypothesis: Hypothesis; action: Action }[] = [];
  for (const s of reply.value.remediations) {
    if (actions.length >= MAX_LLM_PROPOSALS) break;
    const hypothesis = top.find((h) => h.id === s.hypothesisId);
    const input = parseObject(s.input);
    if (!hypothesis || !input) {
      notes.push(`LLM remediation ${s.tool} rejected: ${hypothesis ? "input is not a JSON object" : `unknown hypothesis ${s.hypothesisId}`}`);
      continue;
    }
    // The tool name and input are untrusted: preview() validates both and policy decides.
    actions.push({ hypothesis, action: { tool: s.tool, input, rationale: s.rationale.slice(0, 300), effect: "fix" } });
  }
  return { actions, notes };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
