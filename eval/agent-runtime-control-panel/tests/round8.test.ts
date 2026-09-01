import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';

class DeliveryCli {
  calls: string[][] = [];
  prompts: string[] = [];
  status = 'running';
  updatedAt = '2026-01-01T00:00:00.000Z';
  failSend = false;
  heartbeatRuns: Array<Record<string, unknown>> = [];
  async run(args: string[]): Promise<any> {
    this.calls.push(args);
    if (args[0] === 'inspect') return { value: { id: args[1], Status: this.status, UpdatedAt: this.updatedAt } };
    if (args[0] === 'send') {
      if (this.failSend) throw new Error('recipient busy');
      this.prompts.push(args.at(-1) ?? '');
      return { value: { status: 'sent' } };
    }
    if (args[0] === 'heartbeat' && args[1] === 'create') {
      this.prompts.push(args[2] ?? '');
      return { value: { id: 'heartbeat-1', status: 'active', lastRunAt: null } };
    }
    if (args[0] === 'schedule' && args[1] === 'inspect') return { value: { schedule: { id: args[2], status: 'active' } } };
    if (args[0] === 'schedule' && args[1] === 'logs') return { value: { runs: this.heartbeatRuns } };
    if (args[0] === 'heartbeat' && args[1] === 'delete') return { value: { status: 'deleted' } };
    return { value: [] };
  }
}

async function makeService(cli = new DeliveryCli()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round8-'));
  const store = new Store(dir); await store.init();
  return { service: new CompanionService(cli as any, store), store, cli };
}

describe('round8 message transport', () => {
  it('arms a repeating heartbeat and keeps on-idle messages pending until it runs', async () => {
    const { service, store, cli } = await makeService();
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'later', mode: 'ack' });
    await (service as any).reconcileMessages();
    const create = cli.calls.find((args) => args[0] === 'heartbeat' && args[1] === 'create');
    expect(create).toEqual(expect.arrayContaining(['--cron', '* * * * *', '--expires-in', '30m']));
    expect(create).not.toContain('--max-runs');
    expect(cli.calls.some((args) => args[0] === 'send')).toBe(false);
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('pending');
  });

  it('keeps failed busy runs active, then delivers and retires after a succeeded run', async () => {
    const { service, store, cli } = await makeService();
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'stable', mode: 'ack' });
    await (service as any).reconcileMessages();
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('pending');
    cli.heartbeatRuns = [{
      id: 'run-busy', scheduledFor: new Date(Date.now() + 1_000).toISOString(),
      startedAt: new Date(Date.now() + 1_000).toISOString(), endedAt: new Date(Date.now() + 1_001).toISOString(),
      status: 'failed', error: 'recipient busy',
    }];
    await (service as any).reconcileMessages();
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('pending');
    expect(store.getMessageSchedules().find((item) => item.batchIds.includes(posted.id))?.status).toBe('active');
    expect(cli.calls.some((args) => args[0] === 'heartbeat' && args[1] === 'delete')).toBe(false);

    const endedAt = new Date(Date.now() + 2_000).toISOString();
    cli.heartbeatRuns.push({
      id: 'run-success', scheduledFor: endedAt, startedAt: endedAt, endedAt,
      status: 'succeeded', error: null,
    });
    await (service as any).reconcileMessages();
    expect(cli.prompts).toHaveLength(1);
    expect(cli.prompts[0]).toContain('<paseo-reminder-delivery to="manager-1" kind="message">');
    expect(cli.prompts[0]).toContain('<note marker="NOT_USER_INPUT">');
    expect(cli.prompts[0]).toContain(`<item id="${posted.id}" from="worker"`);
    expect(cli.prompts[0]).toContain('<body>stable</body>');
    expect(cli.prompts[0]).toContain(`<ack>arcp message ack ${posted.id}`);
    expect(cli.prompts[0]).toContain('</paseo-reminder-delivery>');
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('delivered');
    expect(cli.calls).toContainEqual(['heartbeat', 'delete', 'heartbeat-1', '--json']);
    expect(store.getMessageSchedules().find((item) => item.batchIds.includes(posted.id))).toEqual(expect.objectContaining({ status: 'completed', lastRunAt: endedAt }));
  });

  it('renders one escaped tagged item per coalesced message', async () => {
    const { service, cli } = await makeService();
    const [first, second] = await Promise.all([
      service.postMessage({ to: 'manager-1', from: 'worker-a', body: 'first <item> & safe', mode: 'ack' }),
      service.postMessage({ to: 'manager-1', from: 'worker-b', body: 'second', mode: 'ack' }),
    ]);
    const prompt = cli.prompts.at(-1)!;
    expect(prompt.match(/  <item id=/g)).toHaveLength(2);
    expect(prompt).toContain(`<item id="${first.id}" from="worker-a"`);
    expect(prompt).toContain(`<item id="${second.id}" from="worker-b"`);
    expect(prompt).toContain('<body>first &lt;item&gt; &amp; safe</body>');
  });

  it('interrupt delivery bypasses idle polling', async () => {
    const { service, store, cli } = await makeService();
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'now', delivery: 'interrupt', mode: 'ack' });
    expect(cli.calls.some((args) => args[0] === 'inspect')).toBe(false);
    expect(cli.calls.some((args) => args[0] === 'heartbeat')).toBe(false);
    expect(cli.prompts).toHaveLength(1);
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('delivered');
  });

  it('retains a failed interrupt for retry without marking it delivered', async () => {
    const cli = new DeliveryCli(); cli.failSend = true;
    const { service, store } = await makeService(cli);
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'retry', delivery: 'interrupt', mode: 'ack' });
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('pending');
    cli.failSend = false;
    await (service as any).reconcileMessages();
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('delivered');
  });

  it('notify delivery clears the record while ack delivery remains observable', async () => {
    const { service, store, cli } = await makeService();
    const notify = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'notice', delivery: 'interrupt' });
    expect(cli.prompts.at(-1)).not.toContain('<ack>');
    const ack = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'ack me', delivery: 'interrupt', mode: 'ack' });
    expect(store.getMessages().some((item) => item.id === notify.id)).toBe(false);
    expect(store.getMessages().find((item) => item.id === ack.id)?.status).toBe('delivered');
  });

  it('retains acknowledged messages as bounded terminal history', async () => {
    const { service, store } = await makeService();
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'ack me', delivery: 'interrupt', mode: 'ack' });
    await expect(service.deleteMessage(posted.id, 'processed')).resolves.toEqual({ id: posted.id, status: 'acknowledged', retirementPending: false });
    expect(store.getMessages().find((item) => item.id === posted.id)).toEqual(expect.objectContaining({
      status: 'acknowledged', acknowledgementReason: 'processed', acknowledgedAt: expect.any(String),
    }));
    await expect(service.deleteMessage(posted.id, 'duplicate')).resolves.toEqual({ id: posted.id, status: 'acknowledged', retirementPending: false });
  });

  it('deprecated urgency aliases map to the new delivery modes', async () => {
    const { service, store, cli } = await makeService();
    const urgent = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'urgent', urgency: 'urgent', mode: 'ack' });
    expect(cli.prompts).toHaveLength(1);
    const normal = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'normal', urgency: 'normal', mode: 'ack' });
    expect(store.getMessages().find((item) => item.id === urgent.id)?.delivery).toBe('interrupt');
    expect(store.getMessages().find((item) => item.id === normal.id)?.delivery).toBe('on-idle');
  });
});
