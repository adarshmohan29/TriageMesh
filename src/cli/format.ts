import type { ChalkInstance } from "chalk";
import type { InvestigationReport, RemediationProposal } from "../orchestrator/report.js";
import type { EvidenceLink } from "../resolver/schema.js";

const SHOWN_HYPOTHESES = 3;
const SHOWN_LINKS = 4;

/**
 * Human-readable report. Takes the chalk instance so tests can render
 * without colour. Text from tool output (log samples, titles) is printed
 * as data and never interpreted.
 */
export function formatReport(report: InvestigationReport, c: ChalkInstance): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const heading = (s: string) => {
    line();
    line(c.bold.underline(s));
  };
  const { alert, resolution, stats } = report;

  line(c.bold(`TriageMesh investigation: ${alert.title}`));
  line(
    c.dim(`alert ${alert.service}.${alert.metric} ${alert.comparator} ${alert.threshold}, fired ${iso(alert.firedAt)}`) +
      c.dim(` · role ${report.role} · llm ${report.llm}`),
  );

  const steps = report.execution.steps;
  const count = (status: string) => steps.filter((s) => s.status === status).length;
  heading("Investigation");
  line(
    `${report.plan.source} plan, ${steps.length} steps: ${c.green(`${count("ok")} ok`)}` +
      (count("failed") ? `, ${c.red(`${count("failed")} failed`)}` : "") +
      (count("skipped") ? `, ${c.yellow(`${count("skipped")} skipped`)}` : "") +
      ` · ${report.evidence.length} evidence · ${stats.toolCalls} tool calls · ${stats.llmCalls} LLM calls · ${stats.executionMs}ms`,
  );

  heading("Root-cause hypotheses");
  if (resolution.hypotheses.length === 0) line(c.yellow("  no hypotheses: the evidence points nowhere in particular"));
  for (const h of resolution.hypotheses.slice(0, SHOWN_HYPOTHESES)) {
    const label = `#${h.rank} ${h.kind} in ${h.service}${h.ref ? ` (${h.ref})` : ""}`;
    line(`  ${h.rank === 1 ? c.bold.green(label) : c.bold(label)}  ${c.dim(`score ${h.score.toFixed(2)}, ${pct(h.confidence)}`)}`);
    line(`     ${h.title}`);
    for (const l of strongest(h.for)) line(c.green(`     + ${l.reason}`) + c.dim(` (${l.weight.toFixed(2)})`));
    for (const l of strongest(h.against)) line(c.red(`     - ${l.reason}`) + c.dim(` (${l.weight.toFixed(2)})`));
  }
  if (resolution.hypotheses.length > SHOWN_HYPOTHESES) line(c.dim(`  … ${resolution.hypotheses.length - SHOWN_HYPOTHESES} more in --json`));

  if (resolution.conflicts.length > 0) {
    heading("Conflicting evidence");
    for (const conflict of resolution.conflicts) {
      line(`  ${c.yellow(conflict.kind)} ${conflict.subject} ${c.dim(`[${conflict.resolution}]`)}`);
      line(`     ${conflict.rationale}`);
    }
  }
  if (resolution.flaggedSources.length > 0 || resolution.ignored.length > 0) {
    heading("Data quality");
    for (const f of resolution.flaggedSources) line(c.yellow(`  ! ${f.source}: ${f.reason}`));
    for (const i of resolution.ignored) line(c.magenta(`  ! ${i.evidenceId} ignored: ${i.reason}`));
  }

  heading("Remediation");
  if (report.remediations.length === 0) line(c.dim("  nothing proposed"));
  for (const p of report.remediations) {
    const mark = p.recommended ? c.bold.green("★") : " ";
    line(`  ${mark} ${c.bold(p.tool)} ${JSON.stringify(p.input)}  ${c.dim(p.tier ?? "unknown tier")}  ${decision(p, c)}`);
    line(`     ${p.rationale}${p.effect === "mitigation" ? c.dim(" (mitigation)") : ""}${p.origin === "llm" ? c.dim(" (LLM suggestion)") : ""}`);
    if (p.preview) line(c.dim(`     dry run: ${p.preview.summary}`));
    for (const w of p.warnings) line(c.yellow(`     ! ${w}`));
  }
  for (const n of report.remediationNotes) line(c.dim(`  · ${n}`));

  if (report.applied) {
    heading("Applied");
    const a = report.applied;
    const status = a.status === "applied" ? c.green(a.status) : c.yellow(a.status);
    line(`  ${status}${a.tool ? ` ${a.tool}` : ""}: ${a.message}`);
  }

  line();
  const chain = report.audit.chainValid ? c.green("chain verified") : c.red("CHAIN BROKEN");
  line(c.dim(`audit: ${report.audit.entries} entries, ${stats.policyDenials} denied, `) + chain);
  return out.join("\n");
}

function decision(p: RemediationProposal, c: ChalkInstance): string {
  switch (p.decision.status) {
    case "allowed":
      return c.green("allowed");
    case "needs_approval":
      return c.yellow("needs approval");
    default:
      return c.red(`${p.decision.status}: ${p.decision.reason}`);
  }
}

function strongest(links: readonly EvidenceLink[]): EvidenceLink[] {
  return links.filter((l) => l.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, SHOWN_LINKS);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
