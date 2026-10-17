import { describe, expect, it } from "vitest";
import { settle, SystemClock, VirtualClock } from "../../src/core/clock.js";

describe("VirtualClock", () => {
  it("starts at the given time and does not move on its own", () => {
    const clock = new VirtualClock(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it("resolves sleep only after time is advanced far enough", async () => {
    const clock = new VirtualClock();
    let done = false;
    void clock.sleep(100).then(() => (done = true));

    await clock.advance(99);
    expect(done).toBe(false);

    await clock.advance(1);
    expect(done).toBe(true);
    expect(clock.now()).toBe(100);
  });

  it("fires timers in due order, FIFO on ties", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    void clock.sleep(30).then(() => order.push("c"));
    void clock.sleep(10).then(() => order.push("a"));
    void clock.sleep(10).then(() => order.push("b"));

    await clock.advance(50);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("reports the timer's due time to code running when it fires", async () => {
    const clock = new VirtualClock();
    let seen = -1;
    void clock.sleep(40).then(() => (seen = clock.now()));

    await clock.advance(100);
    expect(seen).toBe(40);
    expect(clock.now()).toBe(100);
  });

  it("fires chained sleeps scheduled during the same advance", async () => {
    const clock = new VirtualClock();
    const times: number[] = [];
    void (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(10);
        times.push(clock.now());
      }
    })();

    await clock.advance(30);
    expect(times).toEqual([10, 20, 30]);
  });

  it("rejects and removes the timer when aborted", async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(100, controller.signal);

    controller.abort(new Error("cancelled"));
    await expect(sleeping).rejects.toThrow("cancelled");
    expect(clock.pendingTimers).toBe(0);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const clock = new VirtualClock();
    await expect(clock.sleep(10, AbortSignal.abort(new Error("early")))).rejects.toThrow("early");
  });

  it("runAll drains every timer", async () => {
    const clock = new VirtualClock();
    void clock.sleep(5);
    void clock.sleep(500);

    await clock.runAll();
    expect(clock.pendingTimers).toBe(0);
    expect(clock.now()).toBe(500);
  });

  it("runAll throws on a timer loop that never ends", async () => {
    const clock = new VirtualClock();
    const loop = async (): Promise<void> => {
      await clock.sleep(1);
      return loop();
    };
    void loop();

    await expect(clock.runAll(50)).rejects.toThrow("exceeded 50 timers");
  });
});

describe("settle", () => {
  it("drives a VirtualClock until the work finishes", async () => {
    const clock = new VirtualClock(0);
    const work = (async () => {
      await clock.sleep(1_000);
      await clock.sleep(500);
      return clock.now();
    })();
    expect(await settle(clock, work)).toBe(1_500);
  });

  it("passes rejections through", async () => {
    const clock = new VirtualClock(0);
    const work = clock.sleep(10).then(() => Promise.reject(new Error("boom")));
    await expect(settle(clock, work)).rejects.toThrow("boom");
  });

  it("leaves other clocks alone", async () => {
    expect(await settle(new SystemClock(), Promise.resolve(7))).toBe(7);
  });
});
