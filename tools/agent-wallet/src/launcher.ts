#!/usr/bin/env node

import { chromium } from 'playwright';

import { BridgeDaemon } from './daemon/index.js';
import { createMcpServer } from './mcp/server.js';
import { getInjectedShimCode } from './shim/injected.js';
import type { BridgeConfig } from './types/index.js';
import { DEFAULT_CONFIG } from './types/index.js';

export interface LaunchOptions {
  /** URL to navigate to */
  url: string;
  /** Partial config overrides */
  config?: Partial<BridgeConfig>;
  /** Run browser in headless mode (default: false) */
  headless?: boolean;
  /** Start MCP server on stdio (default: false) */
  mcp?: boolean;
}

export async function launch(options: LaunchOptions) {
  const config: BridgeConfig = { ...DEFAULT_CONFIG, ...options.config };

  if (config.privateKey && !/^0x[a-fA-F0-9]{64}$/.test(config.privateKey)) {
    throw new Error('Invalid private key: expected 32-byte hex string with 0x prefix.');
  }

  const daemon = new BridgeDaemon(config);
  await daemon.start();
  const address = daemon.address;
  console.log(`[agent-wallet] Daemon started on ws://127.0.0.1:${config.wsPort}`);
  console.log(`[agent-wallet] Wallet address: ${address ?? '(unset — set via MCP)'}`);
  console.log(`[agent-wallet] Chain ID: ${config.chainId}`);
  console.log(`[agent-wallet] Auto-approve: ${config.autoApprove}`);

  let mcpServer: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  let browser;
  try {
    if (options.mcp) {
      mcpServer = createMcpServer(daemon);
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const transport = new StdioServerTransport();
      await mcpServer.connect(transport);
      console.error('[agent-wallet] MCP server started on stdio');
    }

    browser = await chromium.launch({
      headless: options.headless ?? false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const shimCode = getInjectedShimCode(config.wsPort);
    await context.addInitScript(shimCode);

    const page = await context.newPage();

    console.log(`[agent-wallet] Navigating to ${options.url}`);
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });

    return { daemon, browser, context, page, address, config, mcpServer };
  } catch (error) {
    if (mcpServer) await mcpServer.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await daemon.stop().catch(() => {});
    throw error;
  }
}

async function main() {
  const url = process.argv[2] || 'https://app.hyperliquid.xyz';

  // All env vars are optional. Anything missing falls back to DEFAULT_CONFIG
  // (or stays unset, e.g. privateKey — set later via MCP set_private_key).
  const privateKey = process.env.AGENT_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  const autoApprove = process.env.AGENT_WALLET_AUTO_APPROVE === 'true';
  const headless = process.env.AGENT_WALLET_HEADLESS === 'true';
  const mcp = process.env.AGENT_WALLET_MCP === 'true';
  const chainId = process.env.AGENT_WALLET_CHAIN_ID
    ? parseInt(process.env.AGENT_WALLET_CHAIN_ID, 10)
    : DEFAULT_CONFIG.chainId;
  const rpcUrl = process.env.AGENT_WALLET_RPC_URL ?? DEFAULT_CONFIG.rpcUrl;
  const wsPort = process.env.AGENT_WALLET_WS_PORT
    ? parseInt(process.env.AGENT_WALLET_WS_PORT, 10)
    : DEFAULT_CONFIG.wsPort;

  const { daemon, browser } = await launch({
    url,
    headless,
    mcp,
    config: {
      ...(privateKey ? { privateKey } : {}),
      autoApprove,
      chainId,
      rpcUrl,
      wsPort,
    },
  });

  const shutdown = async () => {
    console.log('\n[agent-wallet] Shutting down...');
    await browser.close();
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('launcher.ts') ||
  process.argv[1].endsWith('launcher.js')
);

if (isMainModule) {
  main().catch((error) => {
    console.error('[agent-wallet] Fatal error:', error);
    process.exit(1);
  });
}
