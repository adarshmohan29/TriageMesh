import chalk from "chalk";
import { userInfo } from "node:os";
import { createLlm } from "../llm/factory.js";
import { fileSink } from "../policy/audit.js";
import { DEFAULT_SIM_LATENCY, investigateIncident, MOCK_RESPONDERS } from "../orchestrator/sim.js";
import { INCIDENTS } from "../sim/incidents/index.js";
import { terminalApprover } from "./approval.js";
import { INVESTIGATE_USAGE, parseInvestigateArgs } from "./args.js";
import { formatReport } from "./format.js";

/** `npm run investigate -- --incident bad-deploy [--role ...] [--apply] [--json]` */
async function main(): Promise<number> {
  const args = parseInvestigateArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${INVESTIGATE_USAGE}\n`);
    return 2;
  }
  const opts = args.value;
  if (opts.help) {
    process.stdout.write(`${INVESTIGATE_USAGE}\n`);
    return 0;
  }
  if (opts.list) {
    for (const i of INCIDENTS) process.stdout.write(`${i.id.padEnd(22)} ${i.title}\n`);
    return 0;
  }

  const llm = createLlm(process.env, MOCK_RESPONDERS);
  if (!llm.ok) {
    process.stderr.write(`${llm.error}\n`);
    return 2;
  }

  const run = await investigateIncident({
    incident: opts.incident ?? "",
    seed: opts.seed,
    role: opts.role,
    apply: opts.apply,
    llm: llm.value,
    // Simulated backends answer with realistic delays on the virtual clock. A
    // real model's latency is real time, so only the mock gets a simulated one.
    latency: { ...DEFAULT_SIM_LATENCY, llmMs: llm.value.name === "mock" ? DEFAULT_SIM_LATENCY.llmMs : 0 },
    approve: terminalApprover({ input: process.stdin, output: process.stderr, approver: userInfo().username }),
    ...(opts.audit && { auditSink: fileSink(opts.audit) }),
  });
  if (!run.ok) {
    process.stderr.write(`${run.error.code}: ${run.error.message}\n`);
    return 1;
  }

  const { report } = run.value;
  process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report, chalk)}\n`);
  return report.audit.chainValid ? 0 : 1;
}

process.exitCode = await main();
