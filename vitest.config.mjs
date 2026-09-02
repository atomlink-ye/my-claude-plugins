import { defineConfig } from "vitest/config";

const sharedTestConfig = {
  environment: "node",
  pool: "forks"
};

export default defineConfig({
  cacheDir: "/tmp/my-claude-plugins-vitest-cache",
  test: {
    // ARCP and Agent Wallet own their TypeScript suites through their local
    // Vitest configurations. Root commands own only the JavaScript suites.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["skills/*/scripts/**"]
    },
    projects: [
      {
        test: {
          name: "unit",
          ...sharedTestConfig,
          include: [
            "eval/opencode-companion/tests/unit/**/*.test.mjs",
            "eval/sandbox-ctl/tests/unit/**/*.test.mjs"
          ],
          testTimeout: 5000
        }
      },
      {
        test: {
          name: "integration",
          ...sharedTestConfig,
          include: ["eval/opencode-companion/tests/integration/**/*.test.mjs"],
          testTimeout: 30000
        }
      }
    ]
  }
});
