import { describe, expect, it } from "vitest";
import { err, map, ok, unwrap } from "../../src/core/result.js";

describe("Result", () => {
  it("map transforms Ok values", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
  });

  it("map passes Err through untouched", () => {
    const failure = err("nope");
    expect(map(failure, (n: number) => n * 3)).toBe(failure);
  });

  it("unwrap returns the Ok value", () => {
    expect(unwrap(ok("x"))).toBe("x");
  });

  it("unwrap rethrows an Error payload as-is", () => {
    const e = new Error("boom");
    expect(() => unwrap(err(e))).toThrow(e);
  });

  it("unwrap wraps non-Error payloads", () => {
    expect(() => unwrap(err({ code: "DENIED" }))).toThrow('unwrap on Err: {"code":"DENIED"}');
  });
});
