#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import { installCspStripRoute } from './browser/csp.js';
import { BridgeDaemon } from './daemon/index.js';
import { createMcpServer } from './mcp/server.js';
import { getInjectedShimCode } from './shim/injected.js';
import type { BridgeConfig } from './types/index.js';
import { DEFAULT_CONFIG } from './types/index.js';

export interface LaunchOptions {
  /** Optional URL to navigate to. If omitted, opens about:blank. */
  url?: string;
  /** Partial config overrides */
  config?: Partial<BridgeConfig>;
  /** Run browser in headless mode (default: false) */
  headless?: boolean;
  /** Start MCP server on stdio (default: false) */
  mcp?: boolean;
  /** Start only the daemon/MCP, without launching Playwright */
  noBrowser?: boolean;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export async function launch(options: LaunchOptions) {
  const config: BridgeConfig = { ...DEFAULT_CONFIG, ...options.config };

  if (config.privateKey && !/^0x[a-fA-F0-9]{64}$/.test(config.privateKey)) {
    throw new Error('Invalid private key: expected 32-byte hex string with 0x prefix.');
  }

  const daemon = new BridgeDaemon(config);
  await daemon.start();
  const address = daemon.address;
  // All status logs go to stderr — when MCP runs over stdio, stdout is reserved for the protocol stream.
  console.error(`[agent-wallet] Daemon started on ws://127.0.0.1:${config.wsPort}`);
  console.error(`[agent-wallet] Wallet address: ${address ?? '(unset — set via MCP)'}`);
  console.error(`[agent-wallet] Chain ID: ${config.chainId}`);
  console.error(`[agent-wallet] Auto-approve: ${config.autoApprove}`);

  let mcpServer: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    if (options.noBrowser) {
      if (options.url) {
        console.warn('[agent-wallet] Ignoring URL because --no-browser mode is enabled');
      }

      mcpServer = createMcpServer(daemon);
      if (options.mcp) {
        const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
        const transport = new StdioServerTransport();
        await mcpServer.connect(transport);
        console.error('[agent-wallet] MCP server started on stdio');
      }

      const shimSourcePath = fileURLToPath(new URL('./shim/injected.ts', import.meta.url));
      console.error('[agent-wallet] No browser mode enabled — Playwright launch skipped');
      console.error(`[agent-wallet] Inject shim via getInjectedShimCode(${config.wsPort}) from ${shimSourcePath}`);
      console.error(`[agent-wallet] Shim bridge URL: ws://127.0.0.1:${config.wsPort}`);

      return { daemon, browser: undefined, context: undefined, page: undefined, address, config, mcpServer };
    }

    browser = await chromium.launch({
      headless: options.headless ?? false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });

    const shouldStripCSP = config.stripCSP === false ? false : (options.mcp === true || config.stripCSP === true);
    if (shouldStripCSP) {
      await installCspStripRoute(context);
    }

    const shimCode = getInjectedShimCode(config.wsPort, config.identity);
    await context.addInitScript(shimCode);

    page = await context.newPage();

    if (options.url) {
      console.error(`[agent-wallet] Navigating to ${options.url}`);
      await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    } else {
      console.error('[agent-wallet] No URL provided — opening about:blank');
      await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    }

    if (options.mcp) {
      mcpServer = createMcpServer(daemon, context);
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const transport = new StdioServerTransport();
      await mcpServer.connect(transport);
      console.error('[agent-wallet] MCP server started on stdio');
    } else {
      mcpServer = createMcpServer(daemon, context);
    }

    return { daemon, browser, context, page, address, config, mcpServer };
  } catch (error) {
    if (mcpServer) await mcpServer.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await daemon.stop().catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cliNoBrowser = args.includes('--no-browser');
  const url = args.find((arg) => !arg.startsWith('-'));

  // All env vars are optional. Anything missing falls back to DEFAULT_CONFIG
  // (or stays unset, e.g. privateKey — set later via MCP set_private_key).
  const privateKey = process.env.AGENT_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  const autoApprove = process.env.AGENT_WALLET_AUTO_APPROVE === 'true';
  const headless = process.env.AGENT_WALLET_HEADLESS === 'true';
  const mcp = process.env.AGENT_WALLET_MCP === 'true';
  const noBrowser = cliNoBrowser || process.env.AGENT_WALLET_NO_BROWSER === 'true';
  const stripCSP = parseOptionalBoolean(process.env.AGENT_WALLET_STRIP_CSP);
  const chainId = process.env.AGENT_WALLET_CHAIN_ID
    ? parseInt(process.env.AGENT_WALLET_CHAIN_ID, 10)
    : DEFAULT_CONFIG.chainId;
  const rpcUrl = process.env.AGENT_WALLET_RPC_URL ?? DEFAULT_CONFIG.rpcUrl;
  const wsPort = process.env.AGENT_WALLET_WS_PORT
    ? parseInt(process.env.AGENT_WALLET_WS_PORT, 10)
    : DEFAULT_CONFIG.wsPort;
  const identity = {
    ...(process.env.AGENT_WALLET_IDENTITY_NAME ? { name: process.env.AGENT_WALLET_IDENTITY_NAME } : {}),
    ...(process.env.AGENT_WALLET_IDENTITY_ICON ? { icon: process.env.AGENT_WALLET_IDENTITY_ICON } : {}),
    ...(process.env.AGENT_WALLET_IDENTITY_RDNS ? { rdns: process.env.AGENT_WALLET_IDENTITY_RDNS } : {}),
  };

  const { daemon, browser, mcpServer } = await launch({
    url,
    headless,
    mcp,
    noBrowser,
    config: {
      ...(privateKey ? { privateKey } : {}),
      autoApprove,
      chainId,
      rpcUrl,
      wsPort,
      ...(typeof stripCSP !== 'undefined' ? { stripCSP } : {}),
      ...(Object.keys(identity).length > 0 ? { identity } : {}),
    },
  });

  const shutdown = async () => {
    console.error('\n[agent-wallet] Shutting down...');
    await mcpServer?.close().catch(() => {});
    await browser?.close().catch(() => {});
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
