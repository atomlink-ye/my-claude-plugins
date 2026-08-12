import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';

class WakeupCli {
  agents: Record<string, any> = {};
  sends: string[] = [];
  updates: string[][] = [];
  dead = new Set<string>();
  async run(args: string[], options: any = {}): Promise<any> {
    if (args[0] === 'ls') return { value: Object.values(this.agents).map((agent) => ({ id: agent.id })) };
    if (args[0] === 'inspect') return { value: this.agents[args[1]] ?? { id: args[1], Status: 'idle', UpdatedAt: new Date().toISOString() } };
    if (args[0] === 'send') { this.sends.push(args.at(-1) ?? ''); return { value: { status: 'sent' } }; }
    if (args[0] === 'schedule' && args[1] === 'inspect') return { value: { id: args[2], status: 'active' } };
    if (args[0] === 'schedule' && args[1] === 'logs') return { value: [] };
    if (args[0] === 'heartbeat' && args[1] === 'update') {
      this.updates.push(args);
      if (this.dead.has(args[2])) throw new Error('DaemonRpcError: heartbeat not found');
      return { value: { id: args[2], status: 'active' } };
    }
    if (args[0] === 'heartbeat' && args[1] === 'create') {
      if (String(args[2] ?? '').startsWith('AUTOMATED_COMPANION_EVENT')) this.sends.push(args[2] ?? '');
      return { value: { id: 'hb-message', status: 'active' } };
    }
    return { value: {} };
  }
}

const detector = { detect: async () => false };

async function makeService(cli = new WakeupCli()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round7-'));
  const store = new Store(dir); await store.init();
  cli.agents = { child: { id: 'child', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() } };
  const service = new CompanionService(cli as any, store, undefined, detector);
  await store.addManager('manager-1'); await store.trackChild('manager-1', 'child', 'explicit');
  return { dir, store, service, cli };
}

describe('round7 registered wakeup sources', () => {
  it('probes with the original cadence, persists registration, and counts a live source', async () => {
    const first = await makeService();
    const source = await first.service.registerWakeupSource('25aa7025', 'manager-1-full-uuid', 'cron:*/30 * * * *');
    expect(source.status).toBe('active');
    expect(first.cli.updates.at(-1)).toEqual(['heartbeat', 'update', '25aa7025', '--cron', '*/30 * * * *', '--json']);
    const listed = await first.service.listChildren('manager-1-full-uuid');
    expect(listed.selfWakeupSources.map((item) => item.id)).toContain('25aa7025');

    const restartedStore = new Store(first.dir); await restartedStore.init();
    expect(restartedStore.getWakeupSource('25aa7025')).toEqual(expect.objectContaining({ agentId: 'manager-1-full-uuid', cadence: 'cron:*/30 * * * *' }));
  });

  it('suppresses manager-bare with two live registered sources', async () => {
    const { service, cli } = await makeService();
    await service.registerWakeupSource('25aa7025', 'manager-1', 'cron:*/30 * * * *');
    await service.registerWakeupSource('27e7a6b5', 'manager-1', 'cron:7,37 * * * *');
    await service.watchdogTick('manager-1');
    expect(cli.updates.filter((args) => args[2] === '25aa7025')).toHaveLength(2);
    expect(cli.updates.filter((args) => args[2] === '27e7a6b5')).toHaveLength(2);
    expect(cli.sends.some((body) => body.includes('event=manager-bare'))).toBe(false);
  });

  it('marks a missing registered source dead and emits a bounded manager-bare warning', async () => {
    const { service, cli, store } = await makeService();
    cli.dead.add('missing-heartbeat');
    const source = await service.registerWakeupSource('missing-heartbeat', 'manager-1', 'cron:*/30 * * * *');
    expect(source.status).toBe('dead');
    await service.watchdogTick('manager-1');
    const alert = cli.sends.find((body) => body.includes('event=manager-bare'));
    expect(alert).toBeDefined();
    expect(alert).toContain('companion-created and registered');
    expect(alert).toContain('external wakeup sources may be invisible');
    expect(alert).not.toContain('no live self wakeup source');
    expect(store.getWakeupSource('missing-heartbeat')?.status).toBe('dead');
  });

  it('opts out only the child-watch while retaining tracked-child observation', async () => {
    const { service, store } = await makeService();
    await store.addReminder({
      id: 'watch-to-cancel', daemonId: 'watch-daemon', agentId: 'manager-1', subjectChildId: 'child',
      kind: 'child-watch', watchKind: 'child', name: 'watch', prompt: 'Structured context: {"watchKind":"child","subjectChildId":"child","cwd":"unknown"}', cron: '* * * * *',
      expiresIn: '1h', status: 'active', alive: true, createdAt: new Date().toISOString(),
    });
    await service.deleteReminder('watch-to-cancel', 'covered elsewhere');
    expect(store.isTrackedChild('manager-1', 'child')).toBe(true);
    expect(store.isChildWatchOptedOut('manager-1', 'child')).toBe(true);
    expect(store.findReminder('watch-to-cancel')?.status).toBe('deleted');
  });

  it('retires an existing child-watch after a later paseo wait appears, without untracking the child', async () => {
    const cli = new WakeupCli();
    let waitLive = false;
    const result = await makeService(cli);
    const service = new CompanionService(cli as any, result.store, undefined, { detect: async () => waitLive });
    await result.store.addReminder({
      id: 'existing-watch', daemonId: 'watch-daemon', agentId: 'manager-1', subjectChildId: 'child',
      kind: 'child-watch', watchKind: 'child', name: 'watch', prompt: 'Structured context: {"watchKind":"child","subjectChildId":"child","cwd":"unknown"}', cron: '* * * * *',
      expiresIn: '1h', status: 'active', alive: true, createdAt: new Date().toISOString(),
    });
    await service.reconcileOnce();
    expect(result.store.findReminder('existing-watch')?.status).toBe('deleted');
    waitLive = true;
    await service.reconcileOnce();
    expect(result.store.findReminder('existing-watch')?.status).toBe('deleted');
    expect(result.store.isTrackedChild('manager-1', 'child')).toBe(true);
  });

  it('does not create child recovery when a paseo wait covers the missed watch, but does when uncovered', async () => {
    let waitLive = true;
    const first = await makeService();
    const covered = new CompanionService(first.cli as any, first.store, undefined, { detect: async () => waitLive });
    await first.store.addReminder({
      id: 'missed-covered', agentId: 'manager-1', subjectChildId: 'child', kind: 'child-watch', watchKind: 'child',
      name: 'covered', prompt: 'covered', cron: '* * * * *', expiresIn: '1h', status: 'active', alive: true,
      missedFires: 2, missedRunIds: ['r1'], createdAt: new Date().toISOString(),
    });
    (covered as any).managerIsIdle = async () => true;
    await (covered as any).ensureHeartbeatRecovery('manager-1');
    expect(first.store.getReminders().some((item) => item.kind === 'heartbeat-recovery')).toBe(false);
    waitLive = false;
    await (covered as any).ensureHeartbeatRecovery('manager-1');
    expect(first.store.getReminders().some((item) => item.kind === 'heartbeat-recovery')).toBe(true);
  });
});
