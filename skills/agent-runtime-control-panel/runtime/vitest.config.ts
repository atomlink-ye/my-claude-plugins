import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../../../eval/agent-runtime-control-panel/tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
