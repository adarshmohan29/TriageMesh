import { describe, expect, it } from "vitest";
import { analyseSeries, median } from "../../src/evidence/series.js";

const MIN = 60_000;
const series = (values: number[]) => values.map((value, i) => ({ t: i * MIN, value }));
const flat = (n: number, v: number) => Array.from({ length: n }, (_, i) => v + (i % 2 === 0 ? 2 : -2));

describe("analyseSeries", () => {
  it("calls a noisy but steady series normal", () => {
    expect(analyseSeries("cpu_pct", series(flat(30, 40)))).toMatchObject({ kind: "normal", baseline: 40 });
  });

  it("finds a sustained step and its onset", () => {
    const verdict = analyseSeries("cpu_pct", series([...flat(20, 40), 90, 92, 95, 91]));
    expect(verdict).toMatchObject({ kind: "anomaly", direction: "up", peak: 95, onset: 20 * MIN });
  });

  it("ignores a spike shorter than the sustain window", () => {
    expect(analyseSeries("cpu_pct", series([...flat(20, 40), 95, 95, 40, 40]))).toMatchObject({ kind: "normal" });
  });

  it("counts a short deviation that is still ongoing at the end of the window", () => {
    expect(analyseSeries("cpu_pct", series([...flat(20, 40), 95, 95]))).toMatchObject({ kind: "anomaly", onset: 20 * MIN });
  });

  it("ignores a single deviating newest point", () => {
    expect(analyseSeries("cpu_pct", series([...flat(20, 40), 95]))).toMatchObject({ kind: "normal" });
  });

  it("reports a drop as direction down", () => {
    expect(analyseSeries("db_connections", series([...flat(20, 60), 14, 15, 13, 14]))).toMatchObject({ kind: "anomaly", direction: "down" });
  });

  // memory-leak: the process was just OOM-killed, so the latest value looks fine.
  it("reports the peak of a deviation even when the latest value has recovered", () => {
    const ramp = Array.from({ length: 10 }, (_, i) => 70 + i * 3);
    const verdict = analyseSeries("mem_pct", series([...flat(20, 45), ...ramp, 45]));
    expect(verdict).toMatchObject({ kind: "anomaly", peak: 97, latest: 45 });
  });

  it("needs an absolute change, not just a relative one", () => {
    expect(analyseSeries("error_rate", series([...flat(20, 0.001).map(() => 0.001), 0.005, 0.005, 0.005, 0.005]))).toMatchObject({ kind: "normal" });
  });

  it("counts events for counter metrics", () => {
    expect(analyseSeries("restarts", series([0, 0, 1, 0, 1]))).toEqual({ kind: "events", count: 2, times: [2 * MIN, 4 * MIN] });
  });

  it("refuses to judge a series that is too short", () => {
    expect(analyseSeries("cpu_pct", series([40, 90, 90]))).toEqual({ kind: "insufficient" });
  });
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
