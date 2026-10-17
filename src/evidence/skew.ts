import { MINUTE_MS } from "../sim/baseline.js";
import { median, type Point } from "./series.js";

export const MAX_SKEW_MINUTES = 15;

/**
 * Estimate how far `other`'s clock is ahead of `reference`'s, in whole
 * minutes, by sliding one series over the other and keeping the shift
 * where values agree best. Two sources measuring the same thing should
 * line up; if they line up best after shifting, one clock is off.
 *
 * Returns undefined when the series can't tell: a flat, noisy signal fits
 * every shift about equally, and voting "0" from it would drown out the one
 * metric (say, a filling disk) that actually has shape. So an estimate is
 * only returned when the best shift fits far better than a typical shift.
 */
export function estimateSkewMs(reference: readonly Point[], other: readonly Point[]): number | undefined {
  const ref = new Map(reference.map((p) => [p.t, p.value]));

  const errorAt = (shiftMinutes: number): number | undefined => {
    let total = 0;
    let n = 0;
    for (const p of other) {
      const r = ref.get(p.t - shiftMinutes * MINUTE_MS);
      if (r === undefined) continue;
      total += Math.abs(p.value - r);
      n++;
    }
    return n >= 10 ? total / n : undefined;
  };

  const errors: { shift: number; error: number }[] = [];
  for (let shift = -MAX_SKEW_MINUTES; shift <= MAX_SKEW_MINUTES; shift++) {
    const error = errorAt(shift);
    if (error !== undefined) errors.push({ shift, error });
  }
  if (errors.length < MAX_SKEW_MINUTES) return undefined;

  // Lowest error wins; ties go to the smaller shift (no skew is the default belief).
  const best = errors.reduce((a, b) => (b.error < a.error || (b.error === a.error && Math.abs(b.shift) < Math.abs(a.shift)) ? b : a));
  const typical = median(errors.map((e) => e.error));
  if (!(best.error < typical * 0.5)) return undefined;
  return best.shift * MINUTE_MS;
}
