import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../../../eval/paseo-reminder/tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
