import { err, ok, type Result } from "../core/result.js";
import { AnthropicLlm } from "./anthropic.js";
import type { LlmClient } from "./client.js";
import { MockLlm, type MockResponders } from "./mock.js";

/**
 * Pick the LLM from the environment. Mock is the default so nothing reaches
 * the network unless explicitly asked to (rule 6).
 */
export function createLlm(
  env: Record<string, string | undefined> = process.env,
  mockResponders: MockResponders = {},
): Result<LlmClient, string> {
  const mode = env.TRIAGEMESH_LLM ?? "mock";
  if (mode === "mock") return ok(new MockLlm(mockResponders));
  if (mode === "anthropic") {
    // The SDK also accepts ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile,
    // so a missing ANTHROPIC_API_KEY alone isn't an error here.
    return ok(new AnthropicLlm(env.TRIAGEMESH_MODEL ? { model: env.TRIAGEMESH_MODEL } : {}));
  }
  return err(`unknown TRIAGEMESH_LLM "${mode}" (expected "mock" or "anthropic")`);
}
