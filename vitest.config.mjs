import { defineConfig } from "vitest/config";

const sharedTestConfig = {
  environment: "node",
  include: ["tests/**/*.test.mjs", "tests/**/*.test.js"],
  coverage: {
    provider: "v8",
    reporter: ["text", "html"],
    include: ["scripts/**"]
  },
  testTimeout: 30000,
  pool: "forks"
};

export default defineConfig({
  cacheDir: "/tmp/opencode-slave-vitest-cache",
  test: {
    ...sharedTestConfig,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.mjs", "tests/unit/**/*.test.js"],
          pool: "forks",
          testTimeout: 5000
        }
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.mjs", "tests/integration/**/*.test.js"],
          pool: "forks",
          testTimeout: 30000
        }
      }
    ]
  }
});
