import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PaseoCli } from '../../../tools/paseo-manager-companion/src/cli.js';
import { createServer } from '../../../tools/paseo-manager-companion/src/server.js';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';
import type { ReminderRecord } from '../../../tools/paseo-manager-companion/src/types.js';

const execFile = promisify(execFileCallback);

type Run = {
  id: string;
  scheduledFor: string;
  startedAt: string;
  endedAt: string;
  status: string;
  agentId: string;
  output: string;
  error: string | null;
};

class DirectPayloadObserver {
  readonly schedules = new Map<string, Record<string, any>>();
  readonly logs = new Map<string, Run[]>();
  readonly modes = new Map<string, 'missing' | 'throw' | 'error'>();

  async scheduleList(): Promise<unknown> {
    return { schedules: [...this.schedules.values()] };
  }
  async scheduleInspect(id: string): Promise<unknown> {
    const mode = this.modes.get(id);
    if (mode === 'missing') return { schedule: null, error: 'Schedule not found' };
    if (mode === 'throw') throw new Error('temporary connection reset');
    if (mode === 'error') return { error: 'temporary schedule service failure' };
    return { schedule: this.schedules.get(id) ?? { id, status: 'active', nextRun: '2026-08-11T01:00:00Z' } };
  }
  async scheduleLogs(id: string): Promise<unknown> {
    return { runs: this.logs.get(id) ?? [] };
  }
}

const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
let running: Awaited<ReturnType<typeof createServer>> | undefined;

afterEach(async () => {
  if (running) {
    running.service.close();
    await new Promise<void>((resolve) => running!.server.close(() => resolve()));
  }
  running = undefined;
  delete process.env.PASEO_SHIM_STATE;
  delete process.env.PASEO_AGENT_ID;
});

function run(id: string, startedAt: string, status: string, agentId = 'manager-1'): Run {
  return { id, scheduledFor: startedAt, startedAt, endedAt: startedAt, status, agentId, output: '', error: status === 'succeeded' ? null : 'recipient busy' };
}

function reminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'local-heartbeat', daemonId: 'hb-main', agentId: 'manager-1', name: 'manager-heartbeat', prompt: 'check',
    cron: '*/5 * * * *', expiresIn: '30m', status: 'active', alive: true,
    createdAt: new Date().toISOString(), ...overrides,
  };
}

async function makeService(observer: DirectPayloadObserver, initialReminders: ReminderRecord[] = [], agents: Record<string, any> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'companion-heartbeats-'));
  const state = path.join(root, 'state.json');
  await writeFile(state, JSON.stringify({ agents, heartbeats: {} }));
  await writeFile(path.join(root, 'reminders.json'), JSON.stringify(initialReminders));
  await writeFile(path.join(root, 'managers.json'), JSON.stringify(initialReminders.length ? ['manager-1'] : []));
  process.env.PASEO_SHIM_STATE = state;
  await chmod(shim, 0o755);
  const service = new CompanionService(new PaseoCli(shim), new Store(root), observer);
  await service.init();
  return { root, state, service };
}

describe('durable heartbeat reconciliation', () => {
  it('delivers one recovery generation after three busy misses, clears only covered run IDs, and carries a fourth miss forward', async () => {
    const observer = new DirectPayloadObserver();
    observer.schedules.set('hb-main', { id: 'hb-main', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    observer.logs.set('hb-main', [run('run-success', '2026-08-11T00:00:00Z', 'succeeded'), run('run-1', '2026-08-11T00:01:00Z', 'failed'), run('run-2', '2026-08-11T00:02:00Z', 'failed'), run('run-3', '2026-08-11T00:03:00Z', 'failed')]);
    const { state, service } = await makeService(observer, [reminder()], {
      'manager-1': { id: 'manager-1', Status: 'running', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'working', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });

    await service.reconcileReminders();
    const savedBusy = service.store.findReminder('local-heartbeat')!;
    expect(savedBusy.missedFires).toBe(3);
    expect(service.store.getMessages()).toHaveLength(0);
    const saved = JSON.parse(await readFile(state, 'utf8'));
    saved.agents['manager-1'].Status = 'idle';
    await writeFile(state, JSON.stringify(saved));
    await service.reconcileReminders();
    const firstMessage = service.store.getMessages()[0];
    const firstSchedule = service.store.getMessageSchedules().find((item) => item.status === 'active')!;
    expect(service.store.getMessages()).toHaveLength(1);
    expect(service.store.getMessageSchedules().filter((item) => ['pending', 'active', 'running'].includes(item.status))).toHaveLength(1);
    expect(firstMessage.body).toContain('missed_fires=3');
    expect(firstMessage.body).toContain('last_delivered_at=2026-08-11T00:00:00Z');
    expect(firstMessage.body).toMatch(/status=working; live_wakeup=(false|unknown); git_dirty=(true|false|unknown)/);

    observer.logs.set('hb-main', [...observer.logs.get('hb-main')!, run('run-4', '2026-08-11T00:04:00Z', 'failed')]);
    await service.reconcileReminders();
    expect(service.store.findReminder('local-heartbeat')!.missedFires).toBe(4);
    observer.schedules.set(firstSchedule.daemonId!, { id: firstSchedule.daemonId, status: 'completed' });
    observer.logs.set(firstSchedule.daemonId!, [run('delivery-1', '2026-08-11T00:05:00Z', 'succeeded')]);
    await service.reconcileOnce();
    expect(service.store.findReminder('local-heartbeat')!.missedRunIds).toEqual(['run-4']);
    expect(service.store.getMessages()).toHaveLength(0);
    await service.reconcileOnce();
    const nextMessage = service.store.getMessages()[0];
    expect(nextMessage.body).toContain('missed_fires=1');
    expect(nextMessage.recoveryRunIds?.['local-heartbeat']).toEqual(['run-4']);
    service.close();
  });

  it('serves exact heartbeat keys over HTTP, records startedAt as last_fired_at, and does not recount runs after restart', async () => {
    const observer = new DirectPayloadObserver();
    observer.schedules.set('hb-main', { id: 'hb-main', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    observer.logs.set('hb-main', [run('run-success', '2026-08-11T00:00:00Z', 'succeeded'), run('run-failed', '2026-08-11T00:01:00Z', 'failed')]);
    const initial = reminder({ expiresIn: '1d' });
    const { root, service } = await makeService(observer, [initial]);
    running = await createServer(service);
    await new Promise<void>((resolve) => running!.server.listen(0, '127.0.0.1', resolve));
    const address = running.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/heartbeats`);
    expect(response.status).toBe(200);
    const [heartbeat] = await response.json() as any[];
    expect(Object.keys(heartbeat).sort()).toEqual(['alive', 'cron', 'id', 'last_delivered_at', 'last_fired_at', 'missed_fires', 'next_run'].sort());
    expect(heartbeat).toEqual({ id: 'hb-main', cron: '*/5 * * * *', last_fired_at: '2026-08-11T00:01:00Z', last_delivered_at: '2026-08-11T00:00:00Z', missed_fires: 1, next_run: '2026-08-11T01:00:00Z', alive: true });
    service.close();
    running = undefined;

    const restartedObserver = new DirectPayloadObserver();
    restartedObserver.schedules.set('hb-main', { id: 'hb-main', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    restartedObserver.logs.set('hb-main', observer.logs.get('hb-main')!);
    const restarted = new CompanionService(new PaseoCli(shim), new Store(root), restartedObserver);
    await restarted.init();
    expect(restarted.store.findReminder('local-heartbeat')!.missedFires).toBe(1);
    expect(restarted.store.findReminder('local-heartbeat')!.observedRunIds).toEqual(['run-success', 'run-failed']);
    restarted.close();
  });

  it('rebuilds an explicitly missing schedule once, while transient observer failures neither rebuild nor duplicate a local watch', async () => {
    const missingObserver = new DirectPayloadObserver();
    missingObserver.schedules.set('hb-old', { id: 'hb-old', status: 'active' });
    missingObserver.modes.set('hb-old', 'missing');
    const { service } = await makeService(missingObserver, [reminder({ daemonId: 'hb-old' })]);
    await service.reconcileReminders();
    const rebuilt = service.store.findReminder('local-heartbeat')!;
    expect(rebuilt.daemonId).toBeTruthy();
    expect(rebuilt.daemonId).not.toBe('hb-old');
    await service.reconcileReminders();
    expect(service.store.getLedger().filter((record) => record.verdict === 'heartbeat-missing-rebuilt')).toHaveLength(1);
    service.close();

    const transientObserver = new DirectPayloadObserver();
    transientObserver.modes.set('hb-transient', 'error');
    const { service: transient } = await makeService(transientObserver, [reminder({ daemonId: 'hb-transient', id: 'watch-local', kind: 'child-watch', watchKind: 'child', subjectChildId: 'child-1' })], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'working', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    await transient.reconcileOnce();
    expect(transient.store.findReminder('watch-local')!.daemonId).toBe('hb-transient');
    expect(transient.store.getReminders()).toHaveLength(1);
    expect(transient.store.getLedger()).toHaveLength(0);
    expect((await transient.listChildren('manager-1')).children[0].hasLiveWakeupSource).toBe('unknown');
    transient.close();
  });

  it('rebuilds a missing heartbeat with only its remaining TTL', async () => {
    const observer = new DirectPayloadObserver();
    observer.modes.set('hb-ttl', 'missing');
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const { state, service } = await makeService(observer, [reminder({ id: 'ttl-local', daemonId: 'hb-ttl', expiresIn: '300s', createdAt })]);
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const created = Object.values(saved.heartbeats)[0] as any;
    expect(Number.parseInt(created.expiresIn, 10)).toBeLessThan(300);
    expect(Number.parseInt(created.expiresIn, 10)).toBeGreaterThan(0);
    service.close();
  });

  it('replaces a dead all-silent fallback but leaves a live fallback idempotent', async () => {
    const deadObserver = new DirectPayloadObserver();
    const dead = await makeService(deadObserver, [reminder({ id: 'dead-fallback', daemonId: undefined, name: 'dead-fallback', kind: 'generic', status: 'dead', alive: false })], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'completed', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    await dead.service.reconcileOnce();
    expect(dead.service.store.getReminders().filter((item) => item.kind === 'generic' && item.status === 'active')).toHaveLength(1);
    dead.service.close();

    const liveObserver = new DirectPayloadObserver();
    liveObserver.schedules.set('hb-live-fallback', { id: 'hb-live-fallback', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    const live = await makeService(liveObserver, [reminder({ id: 'live-fallback', daemonId: 'hb-live-fallback', name: 'live-fallback', kind: 'generic', status: 'active', alive: true })], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'completed', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    await live.service.reconcileOnce();
    const firstIds = live.service.store.getReminders().filter((item) => item.kind === 'generic' && item.status === 'active').map((item) => item.id);
    await live.service.reconcileOnce();
    expect(live.service.store.getReminders().filter((item) => item.kind === 'generic' && item.status === 'active').map((item) => item.id)).toEqual(firstIds);
    expect(live.service.store.getReminders().filter((item) => item.kind === 'generic' && item.status === 'active')).toHaveLength(1);
    live.service.close();
  });

  it('resolves only git worktree/cwd paths and reports clean, dirty, or unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-git-'));
    const repo = path.join(root, 'repo');
    await execFile('mkdir', ['-p', repo]);
    await execFile('git', ['-C', repo, 'init', '-q']);
    await execFile('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await execFile('git', ['-C', repo, 'config', 'user.name', 'test']);
    await writeFile(path.join(repo, 'tracked.txt'), 'clean\n');
    await execFile('git', ['-C', repo, 'add', 'tracked.txt']);
    await execFile('git', ['-C', repo, 'commit', '-qm', 'initial']);
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {
      'manager-1': { id: 'manager-1', Status: 'running' },
      'child-clean': { id: 'child-clean', Id: 'child-clean', ParentAgentId: 'manager-1', Status: 'running', Cwd: repo, Worktree: repo },
    }, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    let children = await service.listChildren('manager-1');
    expect(children.children[0]).toEqual(expect.objectContaining({ cwd: repo, gitDirty: false }));
    await writeFile(path.join(repo, 'dirty.txt'), 'dirty\n');
    children = await service.listChildren('manager-1');
    expect(children.children[0].gitDirty).toBe(true);
    const saved = JSON.parse(await readFile(state, 'utf8'));
    // Even a clean git Cwd is untrusted without explicit Worktree metadata.
    saved.agents['child-clean'].Cwd = repo;
    delete saved.agents['child-clean'].Worktree;
    await writeFile(state, JSON.stringify(saved));
    children = await service.listChildren('manager-1');
    expect(children.children[0].cwd).toBeUndefined();
    expect(children.children[0].gitDirty).toBe('unknown');
    service.close();
  });

  it('reports expired heartbeats as dead and deletes a missing daemon schedule idempotently', async () => {
    const observer = new DirectPayloadObserver();
    observer.modes.set('hb-expired', 'missing');
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-expired-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    const deleteShim = fileURLToPath(new URL('../fixtures/not-found-delete-shim.mjs', import.meta.url));
    await chmod(deleteShim, 0o755);
    await writeFile(path.join(root, 'reminders.json'), JSON.stringify([reminder({ id: 'expired-local', daemonId: 'hb-expired', expiresIn: '1s', createdAt: '2020-01-01T00:00:00Z' })]));
    await writeFile(path.join(root, 'managers.json'), JSON.stringify(['manager-1']));
    const service = new CompanionService(new PaseoCli(deleteShim), new Store(root), observer);
    await service.init();
    const heartbeats = await service.listHeartbeats();
    expect(heartbeats[0].alive).toBe(false);
    expect(JSON.parse(await readFile(state, 'utf8')).heartbeats).toEqual({});
    running = await createServer(service);
    await new Promise<void>((resolve) => running!.server.listen(0, '127.0.0.1', resolve));
    const address = running.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/reminders/expired-local`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'expired' }) });
    expect(response.status).toBe(200);
    expect(service.store.findReminder('expired-local')?.status).toBe('deleted');
    service.close();
  });

  it('treats structured daemon-missing evidence as idempotent before local expiry', async () => {
    const observer = new DirectPayloadObserver();
    observer.modes.set('hb-direct-missing', 'missing');
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-direct-delete-'));
    await writeFile(path.join(root, 'reminders.json'), JSON.stringify([reminder({ id: 'direct-local', daemonId: 'hb-direct-missing', expiresIn: '1d' })]));
    const service = new CompanionService(new PaseoCli(shim), new Store(root), observer);
    await service.store.init();
    const result = await service.deleteReminder('direct-local', 'already gone');
    expect(result).toEqual({ id: 'direct-local', status: 'deleted' });
    expect(service.store.findReminder('direct-local')?.status).toBe('deleted');
  });
});
