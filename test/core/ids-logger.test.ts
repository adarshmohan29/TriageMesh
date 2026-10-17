import { describe, expect, it } from "vitest";
import { createIdGenerator } from "../../src/core/ids.js";
import { createLogger } from "../../src/core/logger.js";

describe("createIdGenerator", () => {
  it("counts independently per prefix", () => {
    const ids = createIdGenerator();
    expect([ids.next("ev"), ids.next("ev"), ids.next("hyp")]).toEqual([
      "ev-0001",
      "ev-0002",
      "hyp-0001",
    ]);
  });

  it("restarts from 1 in a fresh generator", () => {
    createIdGenerator().next("ev");
    expect(createIdGenerator().next("ev")).toBe("ev-0001");
  });
});

describe("createLogger", () => {
  it("drops messages below the threshold", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", sink: (l) => lines.push(l) });
    log.info("ignored");
    log.error("kept", { step: "s1" });
    expect(lines).toEqual(['[error] kept {"step":"s1"}']);
  });
});
