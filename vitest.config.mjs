import { defineConfig } from "vitest/config";

const sharedTestConfig = {
  environment: "node",
  include: ["eval/*/tests/**/*.test.mjs", "eval/*/tests/**/*.test.js"],
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
          include: ["eval/*/tests/unit/**/*.test.mjs", "eval/*/tests/unit/**/*.test.js"],
          pool: "forks",
          testTimeout: 5000
        }
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["eval/*/tests/integration/**/*.test.mjs", "eval/*/tests/integration/**/*.test.js"],
          pool: "forks",
          testTimeout: 30000
        }
      }
    ]
  }
});
