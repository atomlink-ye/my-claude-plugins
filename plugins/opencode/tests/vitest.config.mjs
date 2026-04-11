import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["plugins/opencode/tests/**/*.test.mjs", "plugins/opencode/tests/**/*.test.js"],
    pool: "forks",
    testTimeout: 5000
  }
});
