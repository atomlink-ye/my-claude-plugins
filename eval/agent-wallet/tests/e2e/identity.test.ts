import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launch } from '../../../../tools/agent-wallet/src/launcher.js';

const INITIAL_IDENTITY = {
  name: 'Test Wallet',
  rdns: 'test.example',
};

async function waitForAnnounceCount(ctx: Awaited<ReturnType<typeof launch>>, count: number) {
  await ctx.page.waitForFunction(
    (expected) => Array.isArray((window as any).__agentWalletAnnouncements)
      && (window as any).__agentWalletAnnouncements.length >= expected,
    count,
  );
}

describe('Agent Wallet EIP-6963 identity announcements', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;

  beforeAll(async () => {
    ctx = await launch({
      url: 'about:blank',
      headless: true,
      config: {
        wsPort: 18549,
        identity: INITIAL_IDENTITY,
      },
    });

    await ctx.page.evaluate(() => {
      const w = window as any;
      w.__agentWalletAnnouncements = [];

      window.addEventListener('eip6963:announceProvider', ((event: CustomEvent) => {
        w.__agentWalletAnnouncements.push({
          uuid: event.detail.info.uuid,
          name: event.detail.info.name,
          icon: event.detail.info.icon,
          rdns: event.detail.info.rdns,
        });
      }) as EventListener);
    });
  }, 30_000);

  afterAll(async () => {
    await ctx?.browser?.close();
    await ctx?.daemon.stop();
  });

  it('announces the configured identity and re-announces updates', async () => {
    await ctx.page.evaluate(() => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    });

    await waitForAnnounceCount(ctx, 1);

    const initialAnnouncement = await ctx.page.evaluate(() => {
      return (window as any).__agentWalletAnnouncements[0];
    });

    expect(initialAnnouncement).toMatchObject(INITIAL_IDENTITY);
    expect(initialAnnouncement.uuid).toEqual(expect.any(String));

    ctx.daemon.setIdentity({ name: 'Renamed' });
    await waitForAnnounceCount(ctx, 2);

    const updatedAnnouncement = await ctx.page.evaluate(() => {
      return (window as any).__agentWalletAnnouncements[1];
    });

    expect(updatedAnnouncement).toMatchObject({
      name: 'Renamed',
      rdns: INITIAL_IDENTITY.rdns,
    });
    expect(updatedAnnouncement.uuid).toEqual(expect.any(String));
    expect(updatedAnnouncement.uuid).not.toBe(initialAnnouncement.uuid);
  });
});
