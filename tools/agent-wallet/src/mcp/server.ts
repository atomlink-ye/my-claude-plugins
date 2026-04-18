import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { installCspStripRoute, uninstallCspStripRoute } from '../browser/csp.js';
import type { BridgeDaemon } from '../daemon/index.js';
import { getInjectedShimCode } from '../shim/injected.js';
import type { PendingRequest } from '../types/index.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HEX_REGEX = /^0x[a-fA-F0-9]*$/;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

function toToolResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

function requireRequest(daemon: BridgeDaemon, id: string): PendingRequest {
  const request = daemon.requestQueue.get(id);

  if (!request) {
    throw new Error(`Pending request not found: ${id}`);
  }

  return request;
}

function getPendingEntry(request: PendingRequest) {
  return {
    id: request.id,
    method: request.method,
    params: request.params,
    timestamp: request.timestamp,
    summary: request.summary ?? summarizeRequest(request),
  };
}

function summarizeRequest(request: PendingRequest): string {
  switch (request.method) {
    case 'personal_sign': {
      const message = extractPersonalSignMessage(request.params);
      return message.decoded ? `Sign message: ${truncate(message.decoded, 80)}` : 'Sign personal message';
    }
    case 'eth_signTypedData_v4':
      return 'Sign typed data';
    case 'eth_sendTransaction': {
      const tx = extractTransaction(request.params);
      if (tx?.to) {
        return `Send transaction to ${String(tx.to)}`;
      }
      return 'Send transaction';
    }
    default:
      return request.method;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function extractPersonalSignMessage(params: unknown[]): { raw: unknown; decoded: string | null } {
  const candidate = params.find((param) => !(typeof param === 'string' && ADDRESS_REGEX.test(param))) ?? params[0];

  if (typeof candidate !== 'string') {
    return { raw: candidate, decoded: null };
  }

  if (!HEX_REGEX.test(candidate) || candidate.length % 2 !== 0) {
    return { raw: candidate, decoded: candidate };
  }

  try {
    const decoded = Buffer.from(candidate.slice(2), 'hex').toString('utf8');
    return { raw: candidate, decoded };
  } catch {
    return { raw: candidate, decoded: null };
  }
}

function extractTypedData(params: unknown[]): Record<string, unknown> | null {
  const candidate = params.find((param) => {
    if (typeof param === 'string') {
      return param.trim().startsWith('{');
    }

    return typeof param === 'object' && param !== null;
  });

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return candidate as Record<string, unknown>;
}

function extractTransaction(params: unknown[]): Record<string, unknown> | null {
  const candidate = params.find((param) => typeof param === 'object' && param !== null);
  return candidate ? (candidate as Record<string, unknown>) : null;
}

function getRequestInspection(request: PendingRequest): Record<string, unknown> {
  switch (request.method) {
    case 'personal_sign': {
      const message = extractPersonalSignMessage(request.params);
      return {
        kind: 'personal_sign',
        message: message.decoded,
        rawMessage: message.raw,
      };
    }
    case 'eth_signTypedData_v4': {
      const typedData = extractTypedData(request.params);
      return {
        kind: 'eth_signTypedData_v4',
        domain: typedData?.domain ?? null,
        message: typedData?.message ?? null,
        primaryType: typedData?.primaryType ?? null,
        types: typedData?.types ?? null,
      };
    }
    case 'eth_sendTransaction': {
      const tx = extractTransaction(request.params);
      return {
        kind: 'eth_sendTransaction',
        to: tx?.to ?? null,
        value: tx?.value ?? null,
        data: tx?.data ?? null,
        from: tx?.from ?? null,
      };
    }
    default:
      return {
        kind: request.method,
        params: request.params,
      };
  }
}

// ---------------------------------------------------------------------------
// Browser tab state (module-level, reset per createMcpServer call)
// ---------------------------------------------------------------------------

let activeBrowserContext: BrowserContext | undefined;
let activeTabIndex = 0;
let launcherBrowserContext: BrowserContext | undefined;
let attachedCdpBrowser: Browser | undefined;
let attachedCdpContext: BrowserContext | undefined;

function bindContextPageLifecycle(browserContext: BrowserContext): void {
  browserContext.on('page', (page: Page) => {
    page.on('close', () => handlePageClose());
  });

  for (const page of browserContext.pages()) {
    page.on('close', () => handlePageClose());
  }
}

function setActiveBrowserContext(browserContext: BrowserContext | undefined): void {
  activeBrowserContext = browserContext;
  activeTabIndex = 0;
  if (browserContext) {
    bindContextPageLifecycle(browserContext);
  }
}

function requireBrowserContext(): BrowserContext {
  if (!activeBrowserContext) {
    throw new Error('no browser context — call attach_to_cdp first or restart without --no-browser');
  }
  return activeBrowserContext;
}

function getActivePage(): Page {
  const ctx = requireBrowserContext();
  const pages = ctx.pages();
  if (pages.length === 0) {
    throw new Error('No open tabs in the browser context.');
  }
  // Clamp in case activeTabIndex is stale
  const idx = Math.min(activeTabIndex, pages.length - 1);
  return pages[idx];
}

function handlePageClose(): void {
  const ctx = activeBrowserContext;
  if (!ctx) return;
  const pages = ctx.pages();
  if (pages.length === 0) {
    activeTabIndex = 0;
    return;
  }
  activeTabIndex = Math.min(activeTabIndex, pages.length - 1);
}

async function getTabEntry(page: Page, index: number) {
  return {
    index,
    url: page.url(),
    title: await page.title(),
    active: index === activeTabIndex,
  };
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

export function createMcpServer(daemon: BridgeDaemon, browserContext?: BrowserContext): McpServer {
  launcherBrowserContext = browserContext;
  attachedCdpBrowser = undefined;
  attachedCdpContext = undefined;
  setActiveBrowserContext(browserContext);

  const server = new McpServer({
    name: 'agent-wallet-bridge',
    version: '0.2.0',
  });

  // ---------------------------------------------------------------------------
  // Wallet & chain tools
  // ---------------------------------------------------------------------------

  server.tool(
    'get_status',
    'Return the current wallet state: address (or null), chainId, rpcUrl, shim connection state, and connected origins.',
    async () => {
      return toToolResult({
        address: daemon.address,
        chainId: daemon.chainId,
        chainIdHex: daemon.chainIdHex,
        rpcUrl: daemon.rpcRouter.getRpcUrl(),
        shimConnected: daemon.isShimConnected,
        connectedOrigins: daemon.connectedOrigins,
      });
    },
  );

  server.tool(
    'set_private_key',
    'Load a private key into the wallet. Replaces any existing key. Notifies all connected dApps via accountsChanged.',
    {
      privateKey: z.string().regex(PRIVATE_KEY_REGEX, 'Expected 0x-prefixed 32-byte hex').describe('0x-prefixed 32-byte hex private key'),
    },
    async ({ privateKey }) => {
      const address = daemon.setPrivateKey(privateKey as `0x${string}`);
      return toToolResult({ address });
    },
  );

  server.tool(
    'generate_private_key',
    'Generate a new random private key, install it, and return the address. The private key is also returned — handle it carefully.',
    async () => {
      const { privateKey, address } = daemon.generatePrivateKey();
      return toToolResult({ address, privateKey });
    },
  );

  server.tool(
    'clear_private_key',
    'Remove the active private key. Notifies dApps via accountsChanged with an empty list.',
    async () => {
      daemon.clearPrivateKey();
      return toToolResult({ address: null });
    },
  );

  server.tool(
    'set_chain',
    'Switch the chain ID (and optionally the upstream RPC URL). Notifies dApps via chainChanged.',
    {
      chainId: z.number().int().positive().describe('Chain ID as a positive integer (e.g. 1, 42161, 8453)'),
      rpcUrl: z.string().url().optional().describe('Optional upstream RPC URL for read-only proxying'),
    },
    async ({ chainId, rpcUrl }) => {
      daemon.setChain(chainId, rpcUrl);
      return toToolResult({
        chainId: daemon.chainId,
        chainIdHex: daemon.chainIdHex,
        rpcUrl: daemon.rpcRouter.getRpcUrl(),
      });
    },
  );

  server.tool(
    'set_identity',
    'Update the EIP-6963 identity announced by the injected shim and trigger a re-announce.',
    {
      name: z.string().min(1).optional().describe('Optional EIP-6963 provider name'),
      icon: z.string().min(1).optional().describe('Optional EIP-6963 provider icon URL or data URL'),
      rdns: z.string().min(1).optional().describe('Optional reverse-DNS identifier'),
    },
    async ({ name, icon, rdns }) => {
      const identity = daemon.setIdentity({
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof icon === 'string' ? { icon } : {}),
        ...(typeof rdns === 'string' ? { rdns } : {}),
      });

      return toToolResult({ identity });
    },
  );

  server.tool(
    'get_pending_requests',
    'List all pending wallet requests.',
    async () => {
      const requests = daemon.requestQueue.getPending().map(getPendingEntry);
      return toToolResult({ requests });
    },
  );

  server.tool(
    'wait_for_request',
    'Wait for the next pending wallet request, or return immediately if one is already queued.',
    {
      timeoutMs: z.number().int().positive().optional().describe('Maximum time to wait in milliseconds (default: 30000)'),
    },
    async ({ timeoutMs }) => {
      const pending = daemon.requestQueue.getPending()[0];
      if (pending) {
        return toToolResult(getPendingEntry(pending));
      }

      const nextRequest = await new Promise<PendingRequest>((resolve, reject) => {
        const effectiveTimeoutMs = timeoutMs ?? 30_000;
        const onAdded = (request: PendingRequest) => {
          cleanup();
          resolve(request);
        };

        const cleanup = () => {
          clearTimeout(timer);
          daemon.requestQueue.off('added', onAdded);
        };

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`wait_for_request timed out after ${effectiveTimeoutMs}ms`));
        }, effectiveTimeoutMs);

        daemon.requestQueue.on('added', onAdded);
      });

      return toToolResult(getPendingEntry(nextRequest));
    },
  );

  server.tool(
    'inspect_request',
    'Inspect a pending wallet request in detail.',
    {
      id: z.string().min(1).describe('Pending request ID'),
    },
    async ({ id }) => {
      const request = requireRequest(daemon, id);

      return toToolResult({
        request: {
          id: request.id,
          method: request.method,
          params: request.params,
          timestamp: request.timestamp,
          summary: request.summary ?? summarizeRequest(request),
          details: getRequestInspection(request),
        },
      });
    },
  );

  server.tool(
    'approve_request',
    'Approve a pending wallet request.',
    {
      id: z.string().min(1).describe('Pending request ID'),
    },
    async ({ id }) => {
      if (!daemon.signer) {
        throw new Error('No wallet account configured. Call set_private_key first.');
      }
      const approved = daemon.requestQueue.approve(id);

      return toToolResult({
        id: approved.id,
        status: approved.status,
        result: approved.result ?? null,
      });
    },
  );

  server.tool(
    'reject_request',
    'Reject a pending wallet request.',
    {
      id: z.string().min(1).describe('Pending request ID'),
      reason: z.string().min(1).optional().describe('Optional rejection reason'),
    },
    async ({ id, reason }) => {
      const rejected = daemon.requestQueue.reject(id, reason ?? 'Rejected by MCP client');

      return toToolResult({
        id: rejected.id,
        status: rejected.status,
        reason: rejected.rejectReason ?? reason ?? 'Rejected by MCP client',
      });
    },
  );

  server.tool(
    'list_accounts',
    'Return the bridge-controlled wallet account, or an empty list if none is set.',
    async () => {
      return toToolResult({
        accounts: daemon.address ? [daemon.address] : [],
      });
    },
  );

  server.tool(
    'get_chain_id',
    'Return the configured chain ID.',
    async () => {
      return toToolResult({
        chainId: daemon.chainId,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Browser control tools
  // ---------------------------------------------------------------------------

  server.tool(
    'attach_to_cdp',
    'Attach agent-wallet to an existing Chrome/Chromium instance over CDP, install the shim + CSP route on the selected context, and make browser tools operate on it.',
    {
      endpoint: z.string().url().describe('HTTP CDP endpoint, e.g. http://127.0.0.1:9222'),
      contextIndex: z.number().int().nonnegative().optional().describe('Existing browser context index to attach to (default: 0)'),
    },
    async ({ endpoint, contextIndex }) => {
      if (attachedCdpBrowser) {
        throw new Error('Already attached to a CDP browser. Call detach_from_cdp before attaching again.');
      }

      const nextBrowser = await chromium.connectOverCDP(endpoint);

      try {
        const nextContextIndex = contextIndex ?? 0;
        const nextContext = nextBrowser.contexts()[nextContextIndex];
        if (!nextContext) {
          throw new Error(`Browser context index ${nextContextIndex} not found. Available contexts: ${nextBrowser.contexts().length}`);
        }

        const shimCode = getInjectedShimCode(daemon.config.wsPort, daemon.identity);
        await installCspStripRoute(nextContext);
        await nextContext.addInitScript(shimCode);

        await Promise.all(nextContext.pages().map(async (page) => {
          try {
            await page.evaluate(shimCode);
          } catch {
            // Best-effort for already-open pages.
          }
        }));

        attachedCdpBrowser = nextBrowser;
        attachedCdpContext = nextContext;
        setActiveBrowserContext(nextContext);

        return toToolResult({
          endpoint,
          contextIndex: nextContextIndex,
          pageCount: nextContext.pages().length,
          attachedAt: Date.now(),
        });
      } catch (error) {
        await nextBrowser.close().catch(() => {});
        throw error;
      }
    },
  );

  server.tool(
    'detach_from_cdp',
    'Detach agent-wallet from a previously attached CDP browser and restore the launcher-owned context if one exists.',
    async () => {
      const contextToDetach = attachedCdpContext;
      const browserToDetach = attachedCdpBrowser;

      if (contextToDetach) {
        await uninstallCspStripRoute(contextToDetach);
      }

      attachedCdpContext = undefined;
      attachedCdpBrowser = undefined;
      setActiveBrowserContext(launcherBrowserContext);

      await browserToDetach?.close().catch(() => {});

      return toToolResult({ detached: true });
    },
  );

  server.tool(
    'navigate',
    'Navigate the active tab to a URL, or open it in a new tab. Waits until DOMContentLoaded.',
    {
      url: z.string().min(1).describe('URL to navigate to'),
      newTab: z.boolean().optional().describe('Open in a new tab instead of navigating the active tab'),
    },
    async ({ url, newTab }) => {
      const ctx = requireBrowserContext();
      let page: Page;

      if (newTab) {
        page = await ctx.newPage();
        const pages = ctx.pages();
        activeTabIndex = pages.indexOf(page);
      } else {
        page = getActivePage();
      }

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const title = await page.title();
      const pages = ctx.pages();
      const tabIndex = pages.indexOf(page);
      if (tabIndex !== -1) activeTabIndex = tabIndex;

      return toToolResult({ tabIndex: activeTabIndex, url: page.url(), title });
    },
  );

  server.tool(
    'list_tabs',
    'List all open browser tabs.',
    async () => {
      const ctx = requireBrowserContext();
      const pages = ctx.pages();
      const tabs = await Promise.all(pages.map((page, index) => getTabEntry(page, index)));
      return toToolResult({ tabs });
    },
  );

  server.tool(
    'switch_tab',
    'Make a tab active by index.',
    {
      index: z.number().int().nonnegative().describe('Tab index from list_tabs'),
    },
    async ({ index }) => {
      const ctx = requireBrowserContext();
      const pages = ctx.pages();
      if (index < 0 || index >= pages.length) {
        throw new Error(`Tab index ${index} out of range (0–${pages.length - 1})`);
      }
      activeTabIndex = index;
      const page = pages[index];
      return toToolResult(await getTabEntry(page, index));
    },
  );

  server.tool(
    'close_tab',
    'Close a tab by index. The active tab pointer is updated if needed.',
    {
      index: z.number().int().nonnegative().describe('Tab index to close'),
    },
    async ({ index }) => {
      const ctx = requireBrowserContext();
      const pages = ctx.pages();
      if (index < 0 || index >= pages.length) {
        throw new Error(`Tab index ${index} out of range (0–${pages.length - 1})`);
      }
      await pages[index].close();
      // handlePageClose fires via the 'close' event, but call it here too for safety
      handlePageClose();
      const remaining = ctx.pages().length;
      return toToolResult({ closed: index, remaining });
    },
  );

  server.tool(
    'screenshot',
    'Capture a screenshot of the active tab. Returns a JSON summary and an image content block (base64 PNG).',
    {
      fullPage: z.boolean().optional().describe('Capture the full scrollable page (default: false)'),
    },
    async ({ fullPage }) => {
      requireBrowserContext();
      const page = getActivePage();
      const buffer = await page.screenshot({ fullPage: fullPage ?? false, type: 'png' });
      const base64 = buffer.toString('base64');
      const byteLength = buffer.byteLength;

      const dimensions = await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          fullWidth: Math.max(
            doc?.scrollWidth ?? 0,
            doc?.clientWidth ?? 0,
            body?.scrollWidth ?? 0,
            body?.clientWidth ?? 0,
          ),
          fullHeight: Math.max(
            doc?.scrollHeight ?? 0,
            doc?.clientHeight ?? 0,
            body?.scrollHeight ?? 0,
            body?.clientHeight ?? 0,
          ),
        };
      });

      const structuredContent: {
        width: number;
        height: number;
        byteLength: number;
        mediaType: 'image/png';
        warning?: string;
      } = {
        width: fullPage ? dimensions.fullWidth : dimensions.viewportWidth,
        height: fullPage ? dimensions.fullHeight : dimensions.viewportHeight,
        byteLength,
        mediaType: 'image/png',
      };

      if (base64.length > 900_000) {
        structuredContent.warning = 'Screenshot base64 payload exceeds 900000 characters; consider fullPage=false or a smaller viewport.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(structuredContent, null, 2),
          },
          {
            type: 'image' as const,
            data: base64,
            mimeType: 'image/png',
          },
        ],
        structuredContent,
      };
    },
  );

  return server;
}

export async function startMcpServer(daemon: BridgeDaemon): Promise<McpServer> {
  const server = createMcpServer(daemon);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return server;
}
