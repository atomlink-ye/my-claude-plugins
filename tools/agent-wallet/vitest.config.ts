import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'viem': path.resolve(__dirname, 'node_modules/viem'),
      'viem/accounts': path.resolve(__dirname, 'node_modules/viem/accounts'),
    },
  },
  test: {
    include: ['../../eval/agent-wallet/tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
