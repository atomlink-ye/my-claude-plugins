#!/usr/bin/env tsx
/**
 * Real browser login test for Hyperliquid via Agent Wallet Bridge.
 *
 * Launches a headless browser with the agent wallet injected,
 * navigates to Hyperliquid, connects the wallet, and verifies login.
 */

import { generatePrivateKey } from 'viem/accounts';
import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

const PRIVATE_KEY = (process.env.AGENT_WALLET_PRIVATE_KEY || generatePrivateKey()) as `0x${string}`;

async function main() {
  console.log('=== Hyperliquid Agent Wallet Login Test ===\n');

  // 1. Launch with auto-approve for testing
  const ctx = await launch({
    url: 'https://app.hyperliquid.xyz',
    headless: true,
    config: {
      privateKey: PRIVATE_KEY,
      chainId: 42161,
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      wsPort: 18547,
      autoApprove: true,
      dbPath: ':memory:',
    },
  });

  const { page, address, daemon, browser } = ctx;
  console.log(`Wallet address: ${address}\n`);

  try {
    // 2. Wait for page to fully load
    console.log('Step 1: Waiting for Hyperliquid to load...');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
      // networkidle can be flaky, fall back to domcontentloaded
    });
    await page.waitForTimeout(3000); // let JS framework initialize

    // 3. Verify window.ethereum is injected
    console.log('Step 2: Verifying window.ethereum injection...');
    const hasEthereum = await page.evaluate(() => typeof (window as any).ethereum !== 'undefined');
    console.log(`  window.ethereum present: ${hasEthereum}`);

    const isMetaMask = await page.evaluate(() => (window as any).ethereum?.isMetaMask);
    console.log(`  isMetaMask: ${isMetaMask}`);

    // 3a. Dismiss Terms of Use modal if present
    console.log('Step 2b: Checking for Terms of Use modal...');
    const termsCheckboxes = page.locator('input[type="checkbox"]');
    const checkboxCount = await termsCheckboxes.count();
    if (checkboxCount > 0) {
      console.log(`  Found ${checkboxCount} checkbox(es) — checking all...`);
      for (let i = 0; i < checkboxCount; i++) {
        await termsCheckboxes.nth(i).check({ force: true }).catch(() => {});
      }
      await page.waitForTimeout(500);
    }

    // Click "Decline" / "Accept" / "Agree" / "Continue" button for terms
    const termsButtons = [
      'button:has-text("Agree")',
      'button:has-text("Accept")',
      'button:has-text("Continue")',
      'button:has-text("I Agree")',
      'button:has-text("Decline")',
    ];
    for (const selector of termsButtons) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Prefer "Agree"/"Accept"/"Continue" over "Decline"
        if (!selector.includes('Decline')) {
          console.log(`  Clicking: ${selector}`);
          await btn.click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    }

    // 4. Try to find and click the Connect button
    console.log('Step 3: Looking for Connect Wallet button...');

    // Take a screenshot to see the initial state
    await page.screenshot({ path: '/tmp/hl-1-initial.png', fullPage: false });
    console.log('  Screenshot saved: /tmp/hl-1-initial.png');

    // Look for common connect wallet patterns on Hyperliquid
    const connectSelectors = [
      'button:has-text("Connect")',
      'button:has-text("Connect Wallet")',
      'button:has-text("connect")',
      '[data-testid="connect-wallet"]',
      '.connect-wallet-button',
      'button:has-text("Log in")',
      'button:has-text("Login")',
    ];

    let clicked = false;
    for (const selector of connectSelectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  Found button: ${selector}`);
        await button.click();
        clicked = true;
        await page.waitForTimeout(2000);
        break;
      }
    }

    if (!clicked) {
      console.log('  No explicit connect button found — wallet may auto-connect on this page');
      // Some Dapps auto-detect window.ethereum and connect
    }

    await page.screenshot({ path: '/tmp/hl-2-after-connect.png', fullPage: false });
    console.log('  Screenshot saved: /tmp/hl-2-after-connect.png');

    // 5. If there's a wallet selection modal, look for MetaMask/injected option
    console.log('Step 4: Checking for wallet selection modal...');
    const walletSelectors = [
      'button:has-text("MetaMask")',
      'button:has-text("Metamask")',
      'button:has-text("Injected")',
      'button:has-text("Browser Wallet")',
      '[data-testid="metamask"]',
      'li:has-text("MetaMask")',
      'div:has-text("MetaMask"):not(:has(div))',
    ];

    for (const selector of walletSelectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  Found wallet option: ${selector}`);
        await button.click();
        await page.waitForTimeout(3000);
        break;
      }
    }

    await page.screenshot({ path: '/tmp/hl-3-after-wallet-select.png', fullPage: false });
    console.log('  Screenshot saved: /tmp/hl-3-after-wallet-select.png');

    // 6. Check if we need to sign anything (Enable Trading)
    console.log('Step 5: Checking for signing requests...');
    await page.waitForTimeout(3000);

    // Check the daemon's activity log
    const logs = daemon.logger.getAll();
    console.log(`  Activity log entries: ${logs.length}`);
    for (const log of logs) {
      console.log(`    ${log.event}: ${log.data?.substring(0, 100) || ''}`);
    }

    // 7. Verify the wallet is connected by checking the page state
    console.log('Step 6: Verifying wallet connection state...');

    // Check if eth_requestAccounts was called by the Dapp
    const accounts = await page.evaluate(async () => {
      try {
        return await (window as any).ethereum.request({ method: 'eth_accounts' });
      } catch {
        return [];
      }
    });
    console.log(`  Connected accounts: ${JSON.stringify(accounts)}`);

    // Look for address display on page (truncated address)
    const addrPrefix = address.toLowerCase().slice(0, 6);
    const addrSuffix = address.toLowerCase().slice(-4);
    const pageContent = await page.content();
    const addressVisible = pageContent.toLowerCase().includes(addrPrefix) || pageContent.toLowerCase().includes(addrSuffix);
    console.log(`  Address visible on page: ${addressVisible}`);

    await page.screenshot({ path: '/tmp/hl-4-final.png', fullPage: false });
    console.log('  Screenshot saved: /tmp/hl-4-final.png');

    // 8. Summary
    console.log('\n=== Results ===');
    console.log(`  Wallet injected: ${hasEthereum}`);
    console.log(`  Accounts available: ${accounts.length > 0}`);
    console.log(`  Signing requests processed: ${logs.filter(l => l.event.includes('approved')).length}`);
    console.log(`  Address on page: ${addressVisible}`);

    const success = hasEthereum && accounts.length > 0;
    console.log(`\n${success ? 'SUCCESS' : 'PARTIAL'}: Agent Wallet Bridge ${success ? 'connected to' : 'injected into'} Hyperliquid`);

  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
