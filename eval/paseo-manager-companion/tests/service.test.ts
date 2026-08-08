import { describe, expect, it } from 'vitest';

describe('paseo manager companion', () => {
  it('exports a server factory', async () => {
    const mod = await import('../../../tools/paseo-manager-companion/src/server.js');
    expect(typeof mod.createServer).toBe('function');
  });
});
