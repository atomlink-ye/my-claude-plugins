import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

// Hardhat's well-known default test key #0 — public, never use with real funds
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const POLYGON_RPCS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
] as const;

describe('Polymarket e2e', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;

  beforeAll(async () => {
    ctx = await launch({
      headless: true,
      config: {
        wsPort: 18547,
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.browser.close();
      await ctx.daemon.stop();
    }
  });

  it(
    'injects window.ethereum with Polygon chain and correct address on polymarket.com',
    async () => {
      const expectedAddress = privateKeyToAccount(KEY).address.toLowerCase();

      let lastError: unknown;

      for (const rpcUrl of POLYGON_RPCS) {
        try {
          ctx.daemon.setChain(137, rpcUrl);
          const returned = ctx.daemon.setPrivateKey(KEY);
          expect(returned.toLowerCase()).toBe(expectedAddress);

          await ctx.page.goto('https://polymarket.com', {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          });

          await ctx.page.waitForFunction(
            () => typeof (window as any).ethereum !== 'undefined',
            { timeout: 10_000 },
          );

          const observed = await ctx.page.evaluate(async () => {
            const ethereum = (window as any).ethereum;
            const chainId = await ethereum.request({ method: 'eth_chainId' });
            const accounts = await ethereum.request({ method: 'eth_accounts' });
            const requestAccounts = await ethereum.request({ method: 'eth_requestAccounts' });

            return {
              hasEthereum: typeof ethereum !== 'undefined',
              chainId,
              accounts,
              requestAccounts,
            };
          });

          console.log(`[polymarket] rpc=${rpcUrl}`);
          console.log(`[polymarket] expected=${expectedAddress}`);
          console.log(`[polymarket] chainId=${observed.chainId}`);
          console.log(`[polymarket] accounts=${JSON.stringify(observed.accounts)}`);
          console.log(`[polymarket] requestAccounts=${JSON.stringify(observed.requestAccounts)}`);

          expect(observed.hasEthereum).toBe(true);
          expect(observed.chainId).toBe('0x89');
          expect(observed.accounts.map((value: string) => value.toLowerCase())).toEqual([expectedAddress]);
          expect(observed.requestAccounts.map((value: string) => value.toLowerCase())).toEqual([expectedAddress]);
          return;
        } catch (error) {
          lastError = error;
          console.warn(`[polymarket] failed with rpc=${rpcUrl}:`, error);
        }
      }

      throw lastError ?? new Error('Polymarket flow failed for all Polygon RPCs');
    },
    90_000,
  );
});
