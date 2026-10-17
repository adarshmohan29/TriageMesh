import { err, type Result } from "../core/result.js";
import {
  validateReply,
  type LlmCallOptions,
  type LlmClient,
  type LlmError,
  type LlmPurpose,
  type LlmRequest,
} from "./client.js";

/** Produces a raw (unvalidated) reply for one purpose. Must be deterministic. */
export type MockResponder = (request: LlmRequest<unknown>) => unknown;

export type MockResponders = Partial<Record<LlmPurpose, MockResponder>>;

/**
 * Offline stand-in for a real model (rule 6). Each purpose has a responder,
 * usually a simple heuristic owned by the module that makes the call. A
 * purpose with no responder replies "unavailable", which exercises the
 * caller's deterministic fallback. Replies are schema-checked exactly as a
 * real model's would be, so a responder returning junk tests that path too.
 */
export class MockLlm implements LlmClient {
  readonly name = "mock";
  readonly #responders: MockResponders;
  /** Every request received, in order. */
  readonly calls: LlmRequest<unknown>[] = [];

  constructor(responders: MockResponders = {}) {
    this.#responders = responders;
  }

  async generate<T>(request: LlmRequest<T>, options: LlmCallOptions = {}): Promise<Result<T, LlmError>> {
    this.calls.push(request as LlmRequest<unknown>);
    if (options.signal?.aborted) return err({ code: "aborted", message: "aborted" });
    const responder = this.#responders[request.purpose];
    if (!responder) return err({ code: "unavailable", message: `mock has no responder for ${request.purpose}` });
    return validateReply(request.schema, responder(request as LlmRequest<unknown>));
  }
}
