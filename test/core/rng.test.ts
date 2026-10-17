import { describe, expect, it } from "vitest";
import { createRng } from "../../src/core/rng.js";

const draw = (seed: number, n = 5) => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe("createRng", () => {
  it("produces the same sequence for the same seed", () => {
    expect(draw(42)).toEqual(draw(42));
  });

  it("produces different sequences for different seeds", () => {
    expect(draw(42)).not.toEqual(draw(43));
  });

  it("keeps next() within [0, 1)", () => {
    for (const x of draw(7, 1_000)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("int() stays within inclusive bounds and hits both ends", () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it("int() rejects an inverted range", () => {
    expect(() => createRng(1).int(5, 1)).toThrow(RangeError);
  });

  it("pick() rejects an empty array", () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });

  it("fork() is independent of how much the parent has drawn", () => {
    const a = createRng(9);
    const b = createRng(9);
    b.next();
    b.next();
    expect(a.fork("sim").next()).toBe(b.fork("sim").next());
  });

  it("forks with different labels diverge", () => {
    const rng = createRng(9);
    expect(rng.fork("sim").next()).not.toBe(rng.fork("executor").next());
  });
});
