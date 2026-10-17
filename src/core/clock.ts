/**
 * Time abstraction. Domain code never calls Date.now() or setTimeout directly;
 * it receives a Clock. Production uses SystemClock; tests and the simulator use
 * VirtualClock, where time only moves when advance() is called. That makes
 * timeouts, retries and hedging fully deterministic and instant to test.
 */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Resolve after `ms`; reject with `signal.reason` if aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(handle);
        reject(signal?.reason);
      };
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

interface Timer {
  due: number;
  // Insertion order breaks ties so timers with the same due time fire FIFO.
  seq: number;
  fire: () => void;
}

export class VirtualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  /** Number of timers waiting to fire. Useful in tests. */
  get pendingTimers(): number {
    return this.#timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer: Timer = {
        due: this.#now + Math.max(0, ms),
        seq: this.#seq++,
        fire: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.#timers = this.#timers.filter((t) => t !== timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#timers.push(timer);
    });
  }

  /**
   * Move time forward by `ms`, firing due timers in order. After each timer we
   * let pending promise callbacks run, so code that sleeps again in response
   * (e.g. a retry loop) gets its next timer scheduled within this same advance.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await flushPromises();
    for (;;) {
      const next = this.#earliest();
      if (!next || next.due > target) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = next.due;
      next.fire();
      await flushPromises();
    }
    this.#now = target;
  }

  /** Advance until no timers remain. Throws if timers keep rescheduling forever. */
  async runAll(maxTimers = 10_000): Promise<void> {
    await flushPromises();
    for (let fired = 0; ; fired++) {
      const next = this.#earliest();
      if (!next) return;
      if (fired >= maxTimers) {
        throw new Error(`VirtualClock.runAll: exceeded ${maxTimers} timers`);
      }
      await this.advance(next.due - this.#now);
    }
  }

  #earliest(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.#timers) {
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) {
        best = t;
      }
    }
    return best;
  }
}

/**
 * Drain the microtask queue. setImmediate runs after all currently queued
 * promise callbacks, so awaiting it lets chained `.then`s settle.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Await work that waits on `clock`. A SystemClock moves by itself; a
 * VirtualClock only moves when told to, so keep firing its timers until the
 * work settles. Each runAll() also yields to the event loop, so real I/O
 * (e.g. an LLM call) still makes progress meanwhile.
 */
export async function settle<T>(clock: Clock, work: Promise<T>): Promise<T> {
  if (!(clock instanceof VirtualClock)) return work;
  let done = false;
  const finished = work.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await clock.runAll();
    // Nothing scheduled on the virtual clock means the work is waiting on
    // real I/O: wait for it (or a moment) instead of spinning.
    if (!done && clock.pendingTimers === 0) await Promise.race([finished, new Promise((r) => setTimeout(r, 10))]);
  }
  return work;
}
