import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { MINUTE_MS } from "../../src/sim/baseline.js";
import { INCIDENTS } from "../../src/sim/incidents/index.js";
import { createSimTools } from "../../src/tools/index.js";
import type { World } from "../../src/sim/world.js";
import { makeWorld } from "../sim/helpers.js";
import { dryRun, invoke } from "./helpers.js";

function breaches(world: World, value: number): boolean {
  return world.alert.comparator === ">" ? value > world.alert.threshold : value < world.alert.threshold;
}

describe("write tools", () => {
  it("all implement dryRun", () => {
    const { world } = makeWorld("bad-deploy");
    const writes = createSimTools(world).filter((t) => t.tier !== "read");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((t) => typeof t.dryRun === "function")).toBe(true);
  });

  it("dryRun does not change the world", async () => {
    const { world } = makeWorld("bad-deploy");
    const before = JSON.stringify(world.snapshot());
    unwrap(await dryRun(world, "deploy.rollback", { service: "payments" }));
    unwrap(await dryRun(world, "db.failover", { to: "db-2" }));
    expect(JSON.stringify(world.snapshot())).toBe(before);
  });
});

describe("deploy.rollback", () => {
  it("previews the version and config it will restore", async () => {
    const { world } = makeWorld("pool-exhaustion");
    const preview = unwrap(await dryRun(world, "deploy.rollback", { service: "payments" }));
    expect(preview.changes).toEqual([
      { target: "payments.version", from: "2.3.0-cfg.7", to: "2.3.0" },
      { target: "payments.db_pool_max", from: 5, to: 50 },
    ]);
    expect(preview.affectedServices).toEqual(["payments"]);
  });

  it("restores the previous version and config", async () => {
    const { world } = makeWorld("pool-exhaustion");
    unwrap(await invoke(world, "deploy.rollback", { service: "payments" }));
    const state = world.stateAt(world.now());
    expect(state.versions.payments).toBe("2.3.0");
    expect(state.config["payments.db_pool_max"]).toBe(50);
  });

  it("refuses to roll back a rollback", async () => {
    const { world } = makeWorld("bad-deploy");
    unwrap(await invoke(world, "deploy.rollback", { service: "payments" }));
    const second = await invoke(world, "deploy.rollback", { service: "payments" });
    expect(second).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("reports not_found for a service that was never deployed", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const result = await invoke(world, "deploy.rollback", { service: "database" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("flags.set", () => {
  it("flips a flag and records who did it", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const out = unwrap(await invoke(world, "flags.set", { flag: "payments.aggressive_retries", enabled: false }));
    expect(out.changed).toBe(true);
    const [event] = world.events({ from: world.now(), to: world.now(), kind: "flag" });
    expect(event).toMatchObject({ flag: "payments.aggressive_retries", enabled: false, actor: "triagemesh" });
  });

  it("is a no-op when the flag already has that value", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const out = unwrap(await invoke(world, "flags.set", { flag: "payments.gateway_fallback", enabled: false }));
    expect(out).toMatchObject({ changed: false, eventIds: [] });
  });

  it("rejects an unknown flag", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const result = await invoke(world, "flags.set", { flag: "no.such_flag", enabled: true });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("attributes the blast radius to the flag's owning service", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const preview = unwrap(await dryRun(world, "flags.set", { flag: "payments.aggressive_retries", enabled: false }));
    expect(preview.affectedServices).toEqual(["payments"]);
  });
});

describe("db.pool.resize", () => {
  it("only accepts the payments service", () => {
    const { world } = makeWorld("pool-exhaustion");
    return expect(invoke(world, "db.pool.resize", { service: "api", size: 50 })).rejects.toThrow();
  });
});

describe("db.failover", () => {
  it("is destructive", () => {
    const { world } = makeWorld("disk-full-injection");
    expect(createSimTools(world).find((t) => t.name === "db.failover")?.tier).toBe("destructive");
  });

  it("refuses to fail over to the current primary", async () => {
    const { world } = makeWorld("disk-full-injection");
    const result = await invoke(world, "db.failover", { to: "db-1" });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("db.drop_table", () => {
  it("is destructive and reports every service in its blast radius", async () => {
    const { world } = makeWorld("disk-full-injection");
    const preview = unwrap(await dryRun(world, "db.drop_table", { table: "charges" }));
    expect(createSimTools(world).find((t) => t.name === "db.drop_table")?.tier).toBe("destructive");
    expect(preview.affectedServices).toEqual(["api", "payments", "database"]);
  });

  it("rejects table names that are not plain identifiers", () => {
    const { world } = makeWorld("disk-full-injection");
    return expect(invoke(world, "db.drop_table", { table: "charges; --" })).rejects.toThrow();
  });
});

// The strongest check that tools and simulator agree: applying each incident's
// known fix through the tools makes the alert clear. The watch window is
// longer than memory-leak's 72-minute OOM cycle; without the fix every
// incident breaches at least once in it, so a no-op tool can't pass.
const SETTLE_MINUTES = 5;
const WATCH_MINUTES = 80;

async function breachingMinutesAfter(id: string, fix: boolean): Promise<number> {
  const { world, clock } = makeWorld(id);
  const [remediation] = world.groundTruth.remediations;
  if (!remediation) throw new Error("incident has no remediation");
  if (fix) unwrap(await invoke(world, remediation.tool, remediation.args));

  const fixedAt = world.now();
  await clock.advance(WATCH_MINUTES * MINUTE_MS);
  const { service, metric } = world.alert;
  const points = world.metrics({ service, metric, source: "prometheus", from: fixedAt + SETTLE_MINUTES * MINUTE_MS, to: world.now() });
  return points.filter((p) => breaches(world, p.value)).length;
}

describe.each(INCIDENTS.map((i) => [i.id] as const))("%s remediation", (id) => {
  it("keeps breaching when nothing is fixed", async () => {
    expect(await breachingMinutesAfter(id, false)).toBeGreaterThan(0);
  });

  it("clears the alert once the known fix is applied", async () => {
    expect(await breachingMinutesAfter(id, true)).toBe(0);
  });
});
