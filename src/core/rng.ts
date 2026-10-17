/**
 * Seeded pseudo-random numbers. Math.random() can't be seeded, so anything
 * that needs randomness (simulator noise, retry jitter) takes an Rng instead.
 * Same seed => same sequence => reproducible tests and benchmarks.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /**
   * Independent child stream named by `label`. Subsystems each take their own
   * fork, so adding a random call in one doesn't shift every other's numbers.
   */
  fork(label: string): Rng;
}

export function createRng(seed: number): Rng {
  return new Mulberry32(seed >>> 0);
}

class Mulberry32 implements Rng {
  #state: number;
  readonly #seed: number;

  constructor(seed: number) {
    this.#seed = seed;
    this.#state = seed;
  }

  // mulberry32: tiny, fast, good-enough statistical quality for simulation.
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Rng.int: invalid range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Rng.pick: empty array");
    return items[this.int(0, items.length - 1)] as T;
  }

  fork(label: string): Rng {
    // Derived from the original seed (not current state), so a fork's stream
    // doesn't depend on how many numbers the parent has drawn.
    return new Mulberry32((this.#seed ^ fnv1a(label)) >>> 0);
  }
}

/** 32-bit FNV-1a string hash. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
