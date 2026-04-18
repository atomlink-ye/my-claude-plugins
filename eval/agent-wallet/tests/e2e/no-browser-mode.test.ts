import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

async function connectAndReadInitialState(port: number) {
  return await new Promise<{ address: string | null; chainIdHex: string }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    socket.once('message', (raw) => {
      const message = JSON.parse(raw.toString());
      socket.close();
      resolve({
        address: message.address ?? null,
        chainIdHex: message.chainIdHex,
      });
    });

    socket.once('error', reject);
  });
}

describe('Agent Wallet no-browser mode', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;
  let client: Client | undefined;

  beforeAll(async () => {
    ctx = await launch({
      noBrowser: true,
      config: {
        wsPort: 18548,
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'agent-wallet-e2e', version: '1.0.0' });
    await Promise.all([
      ctx.mcpServer!.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await ctx?.mcpServer?.close();
    await ctx?.daemon.stop();
  });

  it('starts only the daemon and exposes a reachable WS server', async () => {
    expect(ctx.daemon).toBeTruthy();
    expect(ctx.browser).toBeUndefined();
    expect(ctx.context).toBeUndefined();
    expect(ctx.page).toBeUndefined();
    expect(ctx.daemon.address).toBeNull();
    expect(ctx.daemon.chainId).toBe(42161);
    expect(ctx.daemon.isShimConnected).toBe(false);
    expect(ctx.daemon.connectedOrigins).toEqual([]);

    const state = await connectAndReadInitialState(ctx.config.wsPort);
    expect(state).toEqual({
      address: null,
      chainIdHex: '0xa4b1',
    });
  });

  it('fails browser MCP tools cleanly in no-browser mode', async () => {
    const result = await client!.callTool({
      name: 'list_tabs',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/no browser context .*attach_to_cdp.*restart without --no-browser/i),
        }),
      ]),
    );
  });
});
