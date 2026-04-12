import { defineConfig } from "vitest/config";

const sharedTestConfig = {
  environment: "node",
  include: ["eval/opencode/tests/**/*.test.mjs", "eval/opencode/tests/**/*.test.js"],
  coverage: {
    provider: "v8",
    reporter: ["text", "html"],
    include: ["plugins/*/scripts/**"]
  },
  testTimeout: 30000,
  pool: "forks"
};

export default defineConfig({
  cacheDir: "/tmp/my-claude-plugins-vitest-cache",
  test: {
    ...sharedTestConfig,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["eval/opencode/tests/unit/**/*.test.mjs", "eval/opencode/tests/unit/**/*.test.js"],
          pool: "forks",
          testTimeout: 5000
        }
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["eval/opencode/tests/integration/**/*.test.mjs", "eval/opencode/tests/integration/**/*.test.js"],
          pool: "forks",
          testTimeout: 30000
        }
      }
    ]
  }
});
