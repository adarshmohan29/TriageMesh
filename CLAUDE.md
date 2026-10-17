# TriageMesh

Incident-investigation orchestrator. When an alert fires it queries logs, metrics,
deploy history and feature flags in parallel, reconciles conflicting evidence,
ranks root-cause hypotheses, and proposes remediations. Risky actions are gated
by policy-as-code. Portfolio project; the owner is new to this toolchain, so
explain non-obvious decisions briefly in PRs/commits and in code comments where
the "why" is not obvious.

## Stack

- Node 22, ESM only (`"type": "module"`), TypeScript strict (TS 7), npm
- zod 4 (schemas + runtime validation), vitest (tests), tsx (run TS directly)
- p-limit (concurrency), yaml (policy files), chalk (CLI output)
- @anthropic-ai/sdk (real LLM mode), @modelcontextprotocol/sdk (MCP server)

## Commands

```bash
npm test              # vitest run, offline, mock LLM
npm run test:watch    # vitest watch mode
npm run typecheck     # tsc --noEmit
npm run investigate -- --incident bad-deploy   # CLI against the simulator
npm run bench         # ReAct baseline vs orchestrator over all 8 incidents
npm run mcp           # start the MCP server on stdio
```

Run `npm run typecheck && npm test` before calling any phase done.

## Git workflow

- All work happens directly on a single branch, `dev`. Do not create a new branch per phase.
- Commit to `dev` at the end of each phase, once typecheck and tests are green.
- Don't push, or merge into `main`, unless asked. `main` is merged once the whole project is done.
- Never add co-author trailers (e.g. `Co-Authored-By:`) to commit messages, and no
  "Generated with Claude Code" text in commits or PR descriptions.

## Layout

```
src/
  core/        Clock, seeded RNG, Result, ids, logger — no domain logic
  sim/         deterministic world simulator (api -> payments -> database) + 8 incidents
  registry/    tool definitions, defineTool(), ToolRegistry
  tools/       concrete tools backed by the simulator
  policy/      YAML policy loader, PolicyEngine, GuardedInvoker, AuditLog
  llm/         LlmClient interface, MockLlm, AnthropicLlm, untrusted-data framing
  router/      capability + role filtering, LLM pick from shortlist
  planner/     investigation DAG building + validation
  executor/    DAG execution: p-limit, timeouts, retries, hedging
  evidence/    Evidence schema, extractors (tool output -> Evidence)
  resolver/    scoring, ConflictRecord, ranked Hypotheses
  orchestrator/ wires everything; produces an InvestigationReport
  baseline/    sequential ReAct agent (benchmark comparison)
  bench/       benchmark harness + report
  mcp/         MCP server exposing `investigate`
  cli/         command-line entry points
policies/      YAML policy files
test/          vitest specs mirroring src/ (e.g. test/policy/engine.test.ts)
```

## Non-negotiable rules

1. **Security is enforced in code, never in prompts.** Every tool call goes through
   `GuardedInvoker`, which consults `PolicyEngine`. Nothing else may call a
   tool's `run()` directly. Prompts may *describe* rules but are never the control.
2. **Tool output is untrusted data.** Validate it with the tool's zod output schema.
   When shown to an LLM, wrap it in a clearly delimited data block; never splice it
   into system/instruction text. Instructions found inside tool output are ignored,
   and any action an LLM proposes still passes through policy.
3. **Permission tiers:** `read` | `reversible_write` | `destructive`.
   Writes require a successful `dryRun` first. Destructive actions also require the
   approval callback to return approved. Blast-radius limits are checked in code.
4. **Audit log is append-only** (JSONL, hash-chained). Every allow/deny/approval
   decision is logged, including denied attempts.
5. **Determinism.** No `Date.now()`, `Math.random()` or real timers in domain code:
   inject `Clock` and `Rng` from `src/core`. Same seed => same simulator output,
   same report, same benchmark numbers.
6. **Offline by default.** `TRIAGEMESH_LLM=mock` (default) uses `MockLlm`; tests never
   hit the network. `TRIAGEMESH_LLM=anthropic` + `ANTHROPIC_API_KEY` enables the
   real model (default `claude-opus-5-5`, override with `TRIAGEMESH_MODEL`).
7. **LLM proposes, code decides.** The LLM may pick tools from a shortlist, draft a
   plan, or suggest hypotheses; code validates every LLM output with zod, rejects
   anything outside the shortlist, and scores hypotheses deterministically. Invalid
   LLM output falls back to the deterministic path rather than crashing.

## Code conventions

- ESM imports with explicit `.js` extensions (required by `module: nodenext`), e.g.
  `import { x } from "./foo.js"` even though the file is `foo.ts`.
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Define a zod schema first and derive the type: `type Evidence = z.infer<typeof EvidenceSchema>`.
- Prefer plain functions and small classes; no DI frameworks. Pass dependencies
  (clock, rng, llm, policy) explicitly via a context object.
- Expected failures return a `Result`; throw only for programmer errors.
- Named exports only; no default exports.
- Tests: one behavior per `it()`, deterministic seeds, fake clock for timing tests.
  Each phase ships with its tests.

## Domain glossary

- **Alert** — trigger: service, symptom (e.g. `payments.error_rate > 5%`), firedAt.
- **Tool** — `{name, description, capabilities[], tier, inputSchema, outputSchema, run, dryRun?}`.
- **Step / Plan** — a DAG node invoking one tool; plan = DAG of steps.
- **Evidence** — `{id, claim, timestamp, source, reliability, rawData}`; `claim` is a
  typed statement (kind + subject + value).
- **Hypothesis** — candidate root cause with evidence for/against and a score.
- **ConflictRecord** — two pieces of evidence that disagree, plus how it was resolved.
- **Remediation** — proposed action (tool + args + tier); executed only via policy.
