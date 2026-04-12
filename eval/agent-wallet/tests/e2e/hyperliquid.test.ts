import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

// Hardhat's default test key #0 — never use with real funds
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;

describe('Hyperliquid Agent Wallet E2E', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;

  beforeAll(async () => {
    ctx = await launch({
      url: 'https://app.hyperliquid.xyz',
      headless: true,
      config: {
        privateKey: TEST_PRIVATE_KEY,
        chainId: 42161,
        rpcUrl: 'https://arb1.arbitrum.io/rpc',
        wsPort: 18546, // different port to avoid conflicts
        autoApprove: true, // auto-sign for testing
        dbPath: ':memory:',
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.browser.close();
      await ctx.daemon.stop();
    }
  });

  it('should inject window.ethereum into the page', async () => {
    const hasEthereum = await ctx.page.evaluate(() => {
      return typeof (window as any).ethereum !== 'undefined';
    });
    expect(hasEthereum).toBe(true);
  });

  it('should report isMetaMask as true', async () => {
    const isMetaMask = await ctx.page.evaluate(() => {
      return (window as any).ethereum?.isMetaMask;
    });
    expect(isMetaMask).toBe(true);
  });

  it('should return the correct account address', async () => {
    const accounts = await ctx.page.evaluate(async () => {
      return (window as any).ethereum.request({ method: 'eth_requestAccounts' });
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toBe(ctx.address.toLowerCase());
  });

  it('should return the correct chain ID', async () => {
    const chainId = await ctx.page.evaluate(async () => {
      return (window as any).ethereum.request({ method: 'eth_chainId' });
    });

    expect(chainId).toBe('0xa4b1'); // 42161 in hex
  });

  it('should handle personal_sign with auto-approve', async () => {
    const signature = await ctx.page.evaluate(async () => {
      const accounts = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      return (window as any).ethereum.request({
        method: 'personal_sign',
        params: ['0x48656c6c6f', accounts[0]], // "Hello" in hex
      });
    });

    // Should return a valid signature (65 bytes = 130 hex chars + 0x prefix)
    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
  }, 15_000);

  it('should handle eth_signTypedData_v4 with auto-approve', async () => {
    const signature = await ctx.page.evaluate(async () => {
      const accounts = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
          ],
          Test: [
            { name: 'value', type: 'string' },
          ],
        },
        primaryType: 'Test',
        domain: {
          name: 'Test',
          version: '1',
          chainId: 42161,
        },
        message: {
          value: 'hello',
        },
      };

      return (window as any).ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [accounts[0], JSON.stringify(typedData)],
      });
    });

    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
  }, 15_000);

  it('should have EIP-6963 provider announced', async () => {
    const providerName = await ctx.page.evaluate(() => {
      return new Promise<string>((resolve) => {
        window.addEventListener('eip6963:announceProvider', ((event: CustomEvent) => {
          resolve(event.detail.info.name);
        }) as EventListener, { once: true });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
      });
    });

    expect(providerName).toBe('Agent Wallet');
  });

  it('should be able to interact with Hyperliquid page without errors', async () => {
    // Verify the page loaded and our wallet is detectable
    // Hyperliquid should see window.ethereum and offer connection
    const pageTitle = await ctx.page.title();
    expect(pageTitle).toBeTruthy();

    // Check no console errors related to our provider
    const errors: string[] = [];
    ctx.page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('ethereum')) {
        errors.push(msg.text());
      }
    });

    // Re-evaluate provider to trigger any lazy checks
    await ctx.page.evaluate(async () => {
      const eth = (window as any).ethereum;
      await eth.request({ method: 'eth_chainId' });
      await eth.request({ method: 'eth_accounts' });
    });

    // Give a moment for any async errors to surface
    await new Promise((r) => setTimeout(r, 1000));
    expect(errors).toHaveLength(0);
  }, 15_000);
});
