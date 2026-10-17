import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { createRng } from "../../src/core/rng.js";
import { DEFAULT_LATENCY, SimLatency } from "../../src/tools/latency.js";

const make = (seed = 1) => {
  const clock = new VirtualClock(0);
  return { clock, latency: new SimLatency(clock, createRng(seed), DEFAULT_LATENCY) };
};

describe("SimLatency", () => {
  it("waits on the clock for the drawn delay", async () => {
    const { clock, latency } = make();
    const expected = latency.delayFor("logs.search", { service: "api" }, 0);
    let done = false;
    const pending = latency.wait("logs.search", { service: "api" }, undefined).then(() => (done = true));
    await clock.advance(expected - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    await pending;
    expect(done).toBe(true);
  });

  it("gives the same request the same delay whatever else was called first", () => {
    const { latency } = make();
    const a = latency.delayFor("metrics.query", { service: "api", metric: "rps" }, 0);
    const { latency: other } = make();
    other.delayFor("logs.search", {}, 0);
    expect(other.delayFor("metrics.query", { metric: "rps", service: "api" }, 0)).toBe(a);
  });

  it("gives a repeated call (retry or hedge) a fresh draw", () => {
    const { latency } = make();
    const draws = [0, 1, 2, 3, 4].map((n) => latency.delayFor("logs.search", { service: "api" }, n));
    expect(new Set(draws).size).toBeGreaterThan(1);
  });

  it("stays within jitter except for occasional stragglers", () => {
    const { latency } = make();
    const base = DEFAULT_LATENCY.baseMs["logs.search"] ?? 0;
    const draws = Array.from({ length: 200 }, (_, n) => latency.delayFor("logs.search", {}, n));
    const slow = draws.filter((d) => d > base * 1.25);
    for (const d of draws.filter((x) => x <= base * 1.25)) expect(d).toBeGreaterThanOrEqual(base * 0.75 - 1);
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.length).toBeLessThan(50);
  });

  it("treats unlisted tools as instant", () => {
    expect(make().latency.delayFor("deploy.rollback", {}, 0)).toBe(0);
  });

  it("returns an aborted error when the call is cancelled", async () => {
    const { latency } = make();
    const controller = new AbortController();
    const pending = latency.wait("logs.search", {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
  });
});
