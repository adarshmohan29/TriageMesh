import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "../core/logger.js";
import { createLlm } from "../llm/factory.js";
import { MOCK_RESPONDERS } from "../orchestrator/sim.js";
import { createMcpServer } from "./create.js";

/**
 * `npm run mcp`: serve `investigate` over stdio. stdout carries JSON-RPC,
 * so all logging goes to stderr. The role comes from the environment
 * (TRIAGEMESH_MCP_ROLE, default "responder"), not from callers.
 */
const log = createLogger();
const llm = createLlm(process.env, MOCK_RESPONDERS);
if (!llm.ok) {
  log.error(llm.error);
  process.exit(2);
}
const role = process.env.TRIAGEMESH_MCP_ROLE ?? "responder";
const server = createMcpServer({ role, llm: llm.value });
await server.connect(new StdioServerTransport());
log.info(`triagemesh MCP server ready (role ${role}, llm ${llm.value.name})`);
