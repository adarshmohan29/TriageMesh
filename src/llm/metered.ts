import type { Clock } from "../core/clock.js";
import type { Result } from "../core/result.js";
import type { LlmCallOptions, LlmClient, LlmError, LlmRequest } from "./client.js";

export interface LlmUsage {
  calls: number;
  /** Estimated (≈4 characters per token); the mock has no real tokenizer. */
  inputTokens: number;
  outputTokens: number;
}

export interface MeteredLlmOptions {
  /** With latencyMs, each call also waits this long on the clock (simulated model latency). */
  clock?: Clock;
  latencyMs?: number;
}

/**
 * Wraps any LlmClient to count calls and estimate tokens, for reports and
 * the benchmark. Optionally adds simulated latency on the injected clock so
 * that "N sequential LLM calls" costs virtual time, as it would for real.
 */
export class MeteredLlm implements LlmClient {
  readonly name: string;
  readonly usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly #inner: LlmClient;
  readonly #options: MeteredLlmOptions;

  constructor(inner: LlmClient, options: MeteredLlmOptions = {}) {
    this.#inner = inner;
    this.#options = options;
    this.name = inner.name;
  }

  async generate<T>(request: LlmRequest<T>, options: LlmCallOptions = {}): Promise<Result<T, LlmError>> {
    this.usage.calls++;
    this.usage.inputTokens += estimateTokens(request.instruction + JSON.stringify(request.data));
    const { clock, latencyMs } = this.#options;
    if (clock && latencyMs) await clock.sleep(latencyMs);
    const result = await this.#inner.generate(request, options);
    if (result.ok) this.usage.outputTokens += estimateTokens(JSON.stringify(result.value) ?? "");
    return result;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
