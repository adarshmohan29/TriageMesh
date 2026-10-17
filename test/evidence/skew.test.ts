import { describe, expect, it } from "vitest";
import { createRng } from "../../src/core/rng.js";
import { estimateSkewMs } from "../../src/evidence/skew.js";

const MIN = 60_000;
const rng = createRng(42);

/** A filling disk: flat, then a steady ramp. */
function disk(i: number): number {
  return i < 20 ? 62 : 62 + (i - 20) * 0.8;
}

function points(n: number, value: (i: number) => number, skewMinutes = 0, noise = 0.003) {
  return Array.from({ length: n }, (_, i) => ({ t: (i + skewMinutes) * MIN, value: value(i) * (1 + rng.float(-noise, noise)) }));
}

describe("estimateSkewMs", () => {
  it("recovers a source whose clock runs 7 minutes fast", () => {
    expect(estimateSkewMs(points(80, disk), points(80, disk, 7))).toBe(7 * MIN);
  });

  it("recovers a clock that runs slow", () => {
    expect(estimateSkewMs(points(80, disk), points(80, disk, -4))).toBe(-4 * MIN);
  });

  it("returns 0 for aligned series with shape", () => {
    expect(estimateSkewMs(points(80, disk), points(80, disk))).toBe(0);
  });

  it("declines to guess from flat noise", () => {
    const flatNoise = (n: number) => points(n, () => 40, 0, 0.06);
    expect(estimateSkewMs(flatNoise(80), flatNoise(80))).toBeUndefined();
  });

  it("declines when the series barely overlap", () => {
    expect(estimateSkewMs(points(8, disk), points(8, disk, 3))).toBeUndefined();
  });
});
