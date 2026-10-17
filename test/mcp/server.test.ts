import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/create.js";
import { InvestigationReportSchema } from "../../src/orchestrator/report.js";

async function connect(role = "responder") {
  const server = createMcpServer({ role });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result: unknown) => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("MCP server", () => {
  it("lists the investigate tool", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual(["investigate"]);
  });

  it("does not let callers choose their role", async () => {
    const { tools } = await (await connect()).listTools();
    expect(Object.keys((tools[0]?.inputSchema.properties ?? {}) as object).sort()).toEqual(["incident", "seed"]);
  });

  it("returns a schema-valid report and a readable summary", async () => {
    const result = await (await connect()).callTool({ name: "investigate", arguments: { incident: "bad-deploy" } });
    const report = InvestigationReportSchema.parse(result.structuredContent);
    expect(report.resolution.hypotheses[0]?.ref).toBe("dep-payments-2.3.1");
    expect(textOf(result)).toContain("#1 bad_deploy in payments");
  });

  it("runs as the server's role", async () => {
    const result = await (await connect("investigator")).callTool({ name: "investigate", arguments: { incident: "bad-deploy" } });
    expect(InvestigationReportSchema.parse(result.structuredContent).role).toBe("investigator");
  });

  it("never applies a remediation", async () => {
    const result = await (await connect("incident_commander")).callTool({ name: "investigate", arguments: { incident: "bad-deploy" } });
    expect(InvestigationReportSchema.parse(result.structuredContent).applied).toBeNull();
  });

  it("redacts injected instructions before handing the report to another model", async () => {
    const result = await (await connect()).callTool({ name: "investigate", arguments: { incident: "disk-full-injection" } });
    const report = InvestigationReportSchema.parse(result.structuredContent);
    const injected = report.evidence.find((e) => e.claim.kind === "suspicious_instruction");
    expect(injected?.claim.value).toMatchObject({ text: expect.stringContaining("redacted") });
    expect(JSON.stringify(result)).not.toContain("drop_table");
  });

  it("rejects an unknown incident", async () => {
    const result = await (await connect()).callTool({ name: "investigate", arguments: { incident: "nope" } });
    expect(result.isError).toBe(true);
  });
});
