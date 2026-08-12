import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';

class DeliveryCli {
  calls: string[][] = [];
  prompts: string[] = [];
  failHeartbeat = false;
  heartbeatLogs: Record<string, any[]> = {};
  async run(args: string[]): Promise<any> {
    this.calls.push(args);
    if (args[0] === 'heartbeat' && args[1] === 'create') {
      if (this.failHeartbeat) throw new Error('daemon rejected heartbeat create: quota');
      const id = `hb-${Object.keys(this.heartbeatLogs).length + 1}`;
      this.heartbeatLogs[id] = [];
      this.prompts.push(args[2]);
      return { value: { id, status: 'active' } };
    }
    if (args[0] === 'heartbeat' && args[1] === 'delete') return { value: { id: args[2], status: 'deleted' } };
    if (args[0] === 'schedule' && args[1] === 'inspect') return { value: { id: args[2], status: 'active' } };
    if (args[0] === 'schedule' && args[1] === 'logs') return { value: this.heartbeatLogs[args[2]] ?? [] };
    if (args[0] === 'send') { this.prompts.push(args.at(-1) ?? ''); return { value: { status: 'sent' } }; }
    if (args[0] === 'ls') return { value: [] };
    return { value: {} };
  }
}

async function makeService(cli = new DeliveryCli()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round8-'));
  const store = new Store(dir); await store.init();
  return { service: new CompanionService(cli as any, store), store, cli };
}

describe('round8 message transport', () => {
  it('uses max-runs one heartbeat by default and never calls send', async () => {
    const { service, cli } = await makeService();
    const message = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'ordinary event' });
    const create = cli.calls.find((args) => args[0] === 'heartbeat' && args[1] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--max-runs', '1']));
    expect(cli.calls.some((args) => args[0] === 'send')).toBe(false);
    expect(message.delivery?.transport).toBe('heartbeat');
    expect(cli.prompts[0].startsWith('AUTOMATED_COMPANION_EVENT transport=heartbeat NOT_USER_INPUT')).toBe(true);
    expect(cli.prompts[0]).not.toContain('transport=fallback-send');
  });

  it('falls back to send only when heartbeat creation fails and marks the reason', async () => {
    const cli = new DeliveryCli(); cli.failHeartbeat = true;
    const { service } = await makeService(cli);
    const message = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'fallback event' });
    expect(cli.calls.some((args) => args[0] === 'send')).toBe(true);
    expect(message.delivery?.transport).toBe('paseo-send');
    expect(service.store.getMessageSchedules().at(-1)?.transportReason).toContain('heartbeat-create-failed');
    expect(cli.prompts.at(-1)?.startsWith('AUTOMATED_COMPANION_EVENT transport=fallback-send NOT_USER_INPUT')).toBe(true);
    expect(cli.prompts.at(-1)).toContain('reason=heartbeat-create-failed: daemon rejected heartbeat create: quota');
    expect(cli.prompts.at(-1)).not.toContain('transport=heartbeat');
  });

  it('uses immediate send only when explicitly requested', async () => {
    const { service, cli } = await makeService();
    await service.postMessage({ to: 'manager-1', from: 'worker', body: 'urgent direct', immediate: true });
    expect(cli.calls.some((args) => args[0] === 'heartbeat' && args[1] === 'create')).toBe(false);
    expect(cli.calls.some((args) => args[0] === 'send')).toBe(true);
    expect(cli.prompts[0].startsWith('AUTOMATED_COMPANION_EVENT transport=fallback-send NOT_USER_INPUT')).toBe(true);
    expect(cli.prompts[0]).toContain('reason=explicit immediate=true');
    expect(cli.prompts[0]).not.toContain('transport=heartbeat');
  });

  it('does not create a second heartbeat after a successful one-shot run', async () => {
    const { service, store, cli } = await makeService();
    const posted = await service.postMessage({ to: 'manager-1', from: 'worker', body: 'once' });
    const schedule = store.getMessageSchedules().at(-1)!;
    cli.heartbeatLogs[schedule.daemonId!] = [{ id: 'run-1', status: 'succeeded', startedAt: new Date().toISOString() }];
    await (service as any).reconcileMessages();
    expect(store.getMessageSchedules().at(-1)?.status).toBe('completed');
    expect(store.getMessages().find((item) => item.id === posted.id)?.status).toBe('delivered');
    const creates = cli.calls.filter((args) => args[0] === 'heartbeat' && args[1] === 'create').length;
    await (service as any).reconcileMessages();
    expect(cli.calls.filter((args) => args[0] === 'heartbeat' && args[1] === 'create')).toHaveLength(creates);
  });

  it('uses heartbeat transport for recovery events by default', async () => {
    const { service, store, cli } = await makeService();
    await store.addManager('manager-1');
    await store.addReminder({ id: 'missed', agentId: 'manager-1', name: 'missed', prompt: 'missed', cron: '* * * * *', expiresIn: '1h', status: 'active', alive: true, missedFires: 1, createdAt: new Date().toISOString() });
    (service as any).managerIsIdle = async () => true;
    await (service as any).ensureHeartbeatRecovery('manager-1');
    expect(cli.calls.some((args) => args[0] === 'heartbeat' && args[1] === 'create' && args.includes('--max-runs') && args.includes('1'))).toBe(true);
    expect(cli.calls.some((args) => args[0] === 'send')).toBe(false);
  });
});
