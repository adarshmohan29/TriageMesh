import { describe, expect, it } from "vitest";
import { unwrap } from "../../src/core/result.js";
import { MINUTE_MS } from "../../src/sim/baseline.js";
import { makeWorld } from "../sim/helpers.js";
import { invoke } from "./helpers.js";

describe("metrics.query", () => {
  it("defaults to the last 60 minutes", async () => {
    const { world } = makeWorld("bad-deploy");
    const out = unwrap(await invoke(world, "metrics.query", { service: "api", metric: "rps", source: "prometheus" }));
    expect(out.to).toBe(world.now());
    expect(out.from).toBe(world.now() - 60 * MINUTE_MS);
    expect(out.points).toHaveLength(61);
  });

  it("returns points from every source unless one is given", async () => {
    const { world } = makeWorld("disk-full-injection");
    const out = unwrap(await invoke(world, "metrics.query", { service: "database", metric: "disk_pct" }));
    expect(new Set(out.points.map((p: { source: string }) => p.source))).toEqual(new Set(["prometheus", "db-agent"]));
  });

  it("rejects a window whose start is after its end", async () => {
    const { world } = makeWorld("bad-deploy");
    const result = await invoke(world, "metrics.query", { service: "api", metric: "rps", from: world.now(), to: world.now() - 1 });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("returns an aborted error when the signal is already aborted", async () => {
    const { world } = makeWorld("bad-deploy");
    const result = await invoke(world, "metrics.query", { service: "api", metric: "rps" }, AbortSignal.abort());
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  });
});

describe("logs.search", () => {
  it("finds the incident's signature log", async () => {
    const { world } = makeWorld("pool-exhaustion");
    const out = unwrap(await invoke(world, "logs.search", { contains: world.incident.signatureLog }));
    expect(out.total).toBeGreaterThan(0);
    expect(out.lines.every((l: { service: string }) => l.service === "payments")).toBe(true);
  });

  it("keeps the newest lines when truncating", async () => {
    const { world } = makeWorld("bad-deploy");
    const all = unwrap(await invoke(world, "logs.search", { limit: 1000 }));
    const few = unwrap(await invoke(world, "logs.search", { limit: 5 }));
    expect(few.truncated).toBe(true);
    expect(few.total).toBe(all.total);
    expect(few.lines).toEqual(all.lines.slice(-5));
  });
});

describe("deploys.list", () => {
  it("lists deploys for one service", async () => {
    const { world } = makeWorld("missing-index");
    const out = unwrap(await invoke(world, "deploys.list", { service: "database" }));
    expect(out.deploys.map((d: { id: string }) => d.id)).toEqual(["dep-db-schema-143"]);
  });

  it("does not show deploys outside the window", async () => {
    const { world } = makeWorld("missing-index");
    const out = unwrap(await invoke(world, "deploys.list", { from: world.minuteToMs(0), to: world.minuteToMs(60) }));
    expect(out.deploys).toEqual([]);
  });
});

describe("flags.list", () => {
  it("shows the current flags and the change that set them", async () => {
    const { world } = makeWorld("flag-retry-storm");
    const out = unwrap(await invoke(world, "flags.list", {}));
    expect(out.current["payments.aggressive_retries"]).toBe(true);
    expect(out.changes.map((c: { id: string }) => c.id)).toEqual(["flag-aggressive-retries-on"]);
  });
});

describe("config.history", () => {
  it("includes config shipped inside a deploy", async () => {
    const { world } = makeWorld("pool-exhaustion");
    const out = unwrap(await invoke(world, "config.history", {}));
    expect(out.current["payments.db_pool_max"]).toBe(5);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ key: "payments.db_pool_max", value: 5, previous: 50, via: "deploy", eventId: "dep-payments-pool-cfg" }),
    );
  });

  it("includes direct config changes", async () => {
    const { world } = makeWorld("disk-full-injection");
    const out = unwrap(await invoke(world, "config.history", { from: world.minuteToMs(0) }));
    expect(out.changes).toContainEqual(expect.objectContaining({ key: "database.replication_slots", via: "config" }));
  });
});

describe("service.status", () => {
  it("reports running versions and the database primary", async () => {
    const { world } = makeWorld("bad-deploy");
    const out = unwrap(await invoke(world, "service.status", {}));
    expect(out.dbPrimary).toBe("db-1");
    expect(out.services.map((s: { service: string }) => s.service)).toEqual(["api", "payments", "database"]);
    const payments = out.services.find((s: { service: string }) => s.service === "payments");
    expect(payments.version).toBe(world.lastDeploy("payments")?.version);
  });
});
