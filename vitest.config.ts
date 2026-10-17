import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests must never reach the real LLM; see CLAUDE.md rule 6.
    env: { TRIAGEMESH_LLM: "mock" },
  },
});
