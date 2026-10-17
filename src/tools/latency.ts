import type { Clock } from "../core/clock.js";
import { canonicalJson } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import type { Rng } from "../core/rng.js";
import type { ToolError } from "../registry/tool.js";

/**
 * How long simulated tool calls take. Real backends are slow and, now and
 * then, very slow; that tail is what makes concurrency, timeouts and
 * hedging worth having, so the benchmark needs it to compare fairly.
 */
export interface LatencyProfile {
  /** Typical latency per tool, in ms. Tools not listed are instant. */
  baseMs: Record<string, number>;
  /** ± fraction of the base, e.g. 0.25 => 75%..125%. */
  jitter: number;
  /** Chance that one call is a straggler. */
  slowChance: number;
  slowFactor: number;
}

export const DEFAULT_LATENCY: LatencyProfile = {
  baseMs: {
    "metrics.query": 300,
    "logs.search": 800,
    "deploys.list": 150,
    "flags.list": 120,
    "config.history": 150,
    "service.status": 80,
  },
  jitter: 0.25,
  slowChance: 0.1,
  slowFactor: 6,
};

/**
 * Waits on the injected clock, so with a VirtualClock "slow" costs no real
 * time. Each call's delay comes from a stream keyed by (tool, input, nth
 * identical call), not by global call order, so two systems making
 * different calls in different orders still see the same latency for the
 * same request, and a retry or hedge of a call gets a fresh draw.
 */
export class SimLatency {
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #profile: LatencyProfile;
  readonly #seen = new Map<string, number>();

  constructor(clock: Clock, rng: Rng, profile: LatencyProfile = DEFAULT_LATENCY) {
    this.#clock = clock;
    this.#rng = rng;
    this.#profile = profile;
  }

  /** The delay the next identical call would get, without consuming it. */
  delayFor(tool: string, input: unknown, nth: number): number {
    const base = this.#profile.baseMs[tool];
    if (base === undefined) return 0;
    const rng = this.#rng.fork(`${tool}|${canonicalJson(input)}|${nth}`);
    const jittered = base * rng.float(1 - this.#profile.jitter, 1 + this.#profile.jitter);
    return Math.round(rng.chance(this.#profile.slowChance) ? jittered * this.#profile.slowFactor : jittered);
  }

  async wait(tool: string, input: unknown, signal: AbortSignal | undefined): Promise<Result<void, ToolError>> {
    const key = `${tool}|${canonicalJson(input)}`;
    const nth = this.#seen.get(key) ?? 0;
    this.#seen.set(key, nth + 1);
    try {
      await this.#clock.sleep(this.delayFor(tool, input, nth), signal);
      return ok(undefined);
    } catch {
      return err({ code: "aborted", message: `${tool} aborted while waiting for its backend` });
    }
  }
}
