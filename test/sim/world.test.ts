import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/sim/baseline.js";
import { makeWorld, valueAt } from "./helpers.js";

describe("World determinism", () => {
  it("produces identical telemetry for the same seed", () => {
    const a = makeWorld("bad-deploy", 7).world.snapshot();
    const b = makeWorld("bad-deploy", 7).world.snapshot();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changes noise but not the timeline for a different seed", () => {
    const a = makeWorld("bad-deploy", 7).world.snapshot();
    const b = makeWorld("bad-deploy", 8).world.snapshot();
    expect(a.metrics).not.toEqual(b.metrics);
    expect(a.events).toEqual(b.events);
  });

  it("gives the same answer regardless of query order", () => {
    const { world: fresh } = makeWorld("missing-index", 3);
    const { world: reordered } = makeWorld("missing-index", 3);
    const late = fresh.minuteToMs(79);
    const early = fresh.minuteToMs(10);

    const expected = [valueAt(fresh, "api", "latency_p95_ms", early), valueAt(fresh, "api", "latency_p95_ms", late)];
    reordered.logs({ from: 0, to: Infinity });
    const lateFirst = valueAt(reordered, "api", "latency_p95_ms", late);
    const earlyAfter = valueAt(reordered, "api", "latency_p95_ms", early);
    expect([earlyAfter, lateFirst]).toEqual(expected);
  });
});

describe("World time", () => {
  it("does not expose telemetry or events from the future", () => {
    const { world } = makeWorld("bad-deploy");
    const now = world.now();
    const points = world.metrics({ service: "api", metric: "rps", from: 0, to: Infinity });
    const logs = world.logs({ from: 0, to: Infinity });
    expect(Math.max(...points.map((p) => p.t))).toBeLessThanOrEqual(now);
    expect(Math.max(...logs.map((l) => l.t))).toBeLessThan(now + MINUTE_MS);
  });

  it("reveals new minutes as the clock advances", async () => {
    const { world, clock } = makeWorld("bad-deploy");
    const before = world.metrics({ service: "api", metric: "rps", from: 0, to: Infinity }).length;
    await clock.advance(5 * MINUTE_MS);
    const after = world.metrics({ service: "api", metric: "rps", from: 0, to: Infinity }).length;
    expect(after).toBe(before + 5);
  });

  it("keeps every metric inside its physical range", () => {
    for (const p of makeWorld("disk-full-injection", 11).world.snapshot().metrics) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      if (p.metric === "error_rate") expect(p.value).toBeLessThanOrEqual(1);
      if (p.metric.endsWith("_pct")) expect(p.value).toBeLessThanOrEqual(100);
    }
  });
});

describe("World events", () => {
  it("applies scripted deploys to state from their timestamp on", () => {
    const { world } = makeWorld("bad-deploy");
    expect(world.stateAt(world.minuteToMs(81)).versions.payments).toBe("2.3.0");
    expect(world.stateAt(world.minuteToMs(82)).versions.payments).toBe("2.3.1");
  });

  it("applies a deploy's config keys", () => {
    const { world } = makeWorld("pool-exhaustion");
    expect(world.stateAt(world.now()).config["payments.db_pool_max"]).toBe(5);
  });

  it("stamps recorded events with the current time and a fresh id", () => {
    const { world } = makeWorld("flag-retry-storm");
    const event = world.record({
      kind: "flag",
      flag: "payments.aggressive_retries",
      enabled: false,
      previous: true,
      actor: "test",
    });
    expect(event.t).toBe(world.now());
    expect(event.id).toBe("evt-0001");
    expect(world.stateAt(world.now()).flags["payments.aggressive_retries"]).toBe(false);
    expect(world.stateAt(world.now() - 1).flags["payments.aggressive_retries"]).toBe(true);
  });

  it("never rewrites minutes that were already observed", () => {
    const { world } = makeWorld("bad-deploy");
    const t = world.minuteToMs(84);
    const before = valueAt(world, "payments", "error_rate", t);
    world.record({
      kind: "deploy",
      service: "payments",
      version: "2.3.0",
      previousVersion: "2.3.1",
      changeType: "rollback",
      description: "rollback",
      actor: "test",
    });
    expect(valueAt(world, "payments", "error_rate", t)).toBe(before);
  });

  it("filters events by kind and service", () => {
    const { world } = makeWorld("bad-deploy");
    const deploys = world.events({ from: 0, to: Infinity, kind: "deploy", service: "payments" });
    expect(deploys.map((e) => e.id)).toEqual(["dep-payments-2.3.1"]);
  });
});
