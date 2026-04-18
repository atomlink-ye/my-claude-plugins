import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '../../../../tools/agent-wallet/node_modules/playwright/index.mjs';
import type { Browser, BrowserContext, Page } from '../../../../tools/agent-wallet/node_modules/playwright/index.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

const CDP_PORT = 19222;

function getStructuredContent<T>(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: T }): T {
  if (result.structuredContent) {
    return result.structuredContent;
  }

  const textBlock = result.content?.find((entry) => entry.type === 'text' && typeof entry.text === 'string');
  if (!textBlock?.text) {
    throw new Error('Missing structured tool result');
  }

  return JSON.parse(textBlock.text) as T;
}

describe('Agent Wallet CDP attach mode', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;
  let client: Client | undefined;
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${CDP_PORT}`],
    });
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    await page.goto('about:blank');

    ctx = await launch({
      noBrowser: true,
      config: {
        wsPort: 18550,
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'agent-wallet-cdp-e2e', version: '1.0.0' });
    await Promise.all([
      ctx.mcpServer!.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.callTool({
        name: 'detach_from_cdp',
        arguments: {},
      });
    } catch {
      // Ignore if attach never succeeded.
    }

    await client?.close();
    await ctx?.mcpServer?.close();
    await ctx?.daemon.stop();
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  it('attaches over CDP, drives browser tools, injects the shim, and detaches cleanly', async () => {
    const attachResult = await client!.callTool({
      name: 'attach_to_cdp',
      arguments: {
        endpoint: `http://127.0.0.1:${CDP_PORT}`,
      },
    });

    expect(attachResult.isError).toBeFalsy();
    expect(getStructuredContent<{ endpoint: string; contextIndex: number; pageCount: number }>(attachResult)).toMatchObject({
      endpoint: `http://127.0.0.1:${CDP_PORT}`,
      contextIndex: 0,
      pageCount: 1,
    });

    const navigateResult = await client!.callTool({
      name: 'navigate',
      arguments: {
        url: 'about:blank',
      },
    });

    expect(navigateResult.isError).toBeFalsy();

    const screenshotResult = await client!.callTool({
      name: 'screenshot',
      arguments: {},
    });

    expect(screenshotResult.isError).toBeFalsy();
    expect(screenshotResult.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
      ]),
    );

    await expect.poll(async () => {
      return await page!.evaluate(() => typeof (window as any).ethereum !== 'undefined');
    }, { timeout: 10_000 }).toBe(true);

    const detachResult = await client!.callTool({
      name: 'detach_from_cdp',
      arguments: {},
    });

    expect(detachResult.isError).toBeFalsy();
    expect(getStructuredContent<{ detached: boolean }>(detachResult)).toEqual({ detached: true });

    const listTabsResult = await client!.callTool({
      name: 'list_tabs',
      arguments: {},
    });

    expect(listTabsResult.isError).toBe(true);
    expect(listTabsResult.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/no browser context .*attach_to_cdp.*restart without --no-browser/i),
        }),
      ]),
    );
  }, 60_000);
});
