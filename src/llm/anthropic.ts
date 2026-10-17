import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { err, type Result } from "../core/result.js";
import { validateReply, type LlmCallOptions, type LlmClient, type LlmError, type LlmRequest } from "./client.js";
import { SYSTEM_PROMPT, renderUserMessage } from "./untrusted.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicLlmOptions {
  model?: string;
  /** Opus 5.5 defaults to "medium"; set explicitly so behaviour doesn't drift. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injected in tests (with a fake fetch); defaults to env credentials. */
  client?: Anthropic;
}

/**
 * Real model behind the LlmClient interface. Uses structured outputs so the
 * API constrains the reply to the request's JSON schema — but the reply is
 * still re-validated with zod (validateReply), because rule 7 says code
 * decides, not the API's promise.
 */
export class AnthropicLlm implements LlmClient {
  readonly name: string;
  /** Real token counts reported by the API, summed over this client's calls. */
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly #model: string;
  readonly #effort: NonNullable<AnthropicLlmOptions["effort"]>;
  readonly #client: Anthropic;

  constructor(options: AnthropicLlmOptions = {}) {
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#effort = options.effort ?? "medium";
    this.#client = options.client ?? new Anthropic();
    this.name = `anthropic:${this.#model}`;
  }

  async generate<T>(request: LlmRequest<T>, options: LlmCallOptions = {}): Promise<Result<T, LlmError>> {
    try {
      const response = await this.#client.beta.messages.parse(
        {
          model: this.#model,
          max_tokens: request.maxTokens ?? 16_000,
          // If a safety classifier declines, the API retries on a suitable
          // model inside the same call instead of failing the investigation.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: this.#effort, format: zodOutputFormat(request.schema) },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: renderUserMessage(request) }],
        },
        options.signal ? { signal: options.signal } : {},
      );
      this.usage.calls++;
      this.usage.inputTokens += response.usage.input_tokens;
      this.usage.outputTokens += response.usage.output_tokens;
      if (response.stop_reason === "refusal") {
        return err({ code: "refused", message: response.stop_details?.explanation ?? "model refused" });
      }
      if (response.stop_reason === "max_tokens") {
        return err({ code: "truncated", message: "reply hit max_tokens" });
      }
      return validateReply(request.schema, response.parsed_output);
    } catch (e) {
      return err(toLlmError(e));
    }
  }
}

/** Most specific first; every failure becomes a fallback, never a crash. */
function toLlmError(e: unknown): LlmError {
  if (e instanceof Anthropic.APIUserAbortError) return { code: "aborted", message: "aborted" };
  if (e instanceof Anthropic.APIError) {
    return { code: "unavailable", message: `Anthropic API ${e.status ?? "connection"} error: ${e.message}` };
  }
  // The SDK throws a plain error when the reply text isn't valid JSON.
  return { code: "invalid_output", message: e instanceof Error ? e.message : String(e) };
}
