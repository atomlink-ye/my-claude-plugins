import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PaseoCli } from '../../../skills/agent-runtime-control-panel/runtime/src/cli.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';
import type { ReminderRecord } from '../../../skills/agent-runtime-control-panel/runtime/src/types.js';

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
  const tracked = Object.values(agents).filter((agent: any) => agent.ParentAgentId === 'manager-1').map((agent: any) => [
    `manager-1\0${agent.id ?? agent.Id}`,
    { managerId: 'manager-1', childId: String(agent.id ?? agent.Id), source: 'explicit', addedAt: new Date().toISOString() },
  ]);
  if (tracked.length) await writeFile(path.join(root, 'tracked-children.json'), JSON.stringify(Object.fromEntries(tracked)));
  process.env.PASEO_SHIM_STATE = state;
  await chmod(shim, 0o755);
  const service = new CompanionService(new PaseoCli(shim), new Store(root), observer);
  await service.init();
  return { root, state, service };
}

describe('durable heartbeat reconciliation', () => {
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
    expect(heartbeat).toEqual({ id: 'hb-main', cron: '*/5 * * * *', last_fired_at: '2026-08-11T00:01:00Z', last_delivered_at: '2026-08-11T00:00:00Z', missed_fires: 0, next_run: '2026-08-11T01:00:00Z', alive: true });
    service.close();
    running = undefined;

    const restartedObserver = new DirectPayloadObserver();
    restartedObserver.schedules.set('hb-main', { id: 'hb-main', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    restartedObserver.logs.set('hb-main', observer.logs.get('hb-main')!);
    const restarted = new CompanionService(new PaseoCli(shim), new Store(root), restartedObserver);
    await restarted.init();
    expect(restarted.store.findReminder('local-heartbeat')!.missedFires).toBe(0);
    expect(restarted.store.findReminder('local-heartbeat')!.observedRunIds).toEqual(['run-success', 'run-failed']);
    restarted.close();
  });

  it('deduplicates exposed heartbeat ids, preferring alive and then newer records', async () => {
    const observer = new DirectPayloadObserver();
    observer.schedules.set('hb-duplicate', { id: 'hb-duplicate', status: 'active', nextRun: '2026-08-11T01:00:00Z' });
    const now = Date.now();
    const old = reminder({ id: 'local-old', daemonId: 'hb-duplicate', cron: '*/5 * * * *', createdAt: new Date(now - 2_000).toISOString() });
    const newer = reminder({ id: 'local-new', daemonId: 'hb-duplicate', cron: '*/7 * * * *', createdAt: new Date(now - 1_000).toISOString() });
    const dead = reminder({ id: 'hb-duplicate', daemonId: undefined, cron: '*/99 * * * *', status: 'dead', alive: false, createdAt: new Date(now).toISOString() });
    const { service } = await makeService(observer, [old, newer, dead]);
    const listed = await service.listHeartbeats();
    expect(listed.filter((item) => item.id === 'hb-duplicate')).toHaveLength(1);
    expect(listed.find((item) => item.id === 'hb-duplicate')).toEqual(expect.objectContaining({ cron: '*/7 * * * *', alive: true }));
  });

  it('deletes the id returned by GET and rejects an ambiguous heartbeat prefix', async () => {
    const observer = new DirectPayloadObserver();
    const first = reminder({ id: 'local-first', daemonId: 'deadbeef-1111', name: 'first' });
    const second = reminder({ id: 'local-second', daemonId: 'deadbeef-2222', name: 'second' });
    observer.schedules.set(first.daemonId!, { id: first.daemonId, status: 'active' });
    observer.schedules.set(second.daemonId!, { id: second.daemonId, status: 'active' });
    const { service } = await makeService(observer, [first, second]);
    const saved = JSON.parse(await readFile((service.store.dir + '/state.json'))) as any;
    saved.heartbeats[first.daemonId!] = { id: first.daemonId, status: 'active', logs: [] };
    saved.heartbeats[second.daemonId!] = { id: second.daemonId, status: 'active', logs: [] };
    await writeFile(service.store.dir + '/state.json', JSON.stringify(saved));
    running = await createServer(service);
    await new Promise<void>((resolve) => running!.server.listen(0, '127.0.0.1', resolve));
    const address = running.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const listed = await (await fetch(`${base}/heartbeats`)).json() as any[];
    const deleted = await fetch(`${base}/heartbeats/${listed[0].id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'done' }) });
    expect(deleted.status).toBe(200);
    expect(service.store.getReminders().find((item) => item.daemonId === listed[0].id)?.status).toBe('deleted');
    const afterDelete = await (await fetch(`${base}/heartbeats`)).json() as any[];
    expect(afterDelete.some((item) => item.id === listed[0].id)).toBe(false);
    const ambiguous = await fetch(`${base}/heartbeats/deadbeef`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'ambiguous' }) });
    expect(ambiguous.status).toBe(409);
    const unique = await fetch(`${base}/heartbeats/deadbeef-2`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'done' }) });
    expect(unique.status).toBe(200);
    service.close();
  });

  it('deleting a child heartbeat explicitly opts out and prevents re-registration', async () => {
    const observer = new DirectPayloadObserver();
    observer.schedules.set('hb-child', { id: 'hb-child', status: 'active' });
    const childWatch = reminder({ id: 'child-watch-local', daemonId: 'hb-child', kind: 'child-watch', watchKind: 'child', subjectChildId: 'child-1' });
    const { state, service } = await makeService(observer, [childWatch], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'working', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    const saved = JSON.parse(await readFile(state, 'utf8'));
    saved.heartbeats['hb-child'] = { id: 'hb-child', status: 'active', logs: [] };
    await writeFile(state, JSON.stringify(saved));

    await service.deleteHeartbeat('hb-child', 'stop watching');
    expect(service.store.isChildWatchOptedOut('manager-1', 'child-1')).toBe(true);
    expect(service.store.findReminder('child-watch-local')?.status).toBe('deleted');
    await service.reconcileOnce();
    expect(service.store.getReminders().filter((item) => item.subjectChildId === 'child-1' && item.status === 'active')).toHaveLength(0);
    service.close();
  });

  it('suppresses opted-out automatic recovery while retaining an explicit message to the child', async () => {
    const observer = new DirectPayloadObserver();
    observer.schedules.set('hb-main', { id: 'hb-main', status: 'active' });
    observer.schedules.set('hb-child', { id: 'hb-child', status: 'active' });
    const childWatch = reminder({ id: 'child-watch-local', daemonId: 'hb-child', kind: 'child-watch', watchKind: 'child', subjectChildId: 'child-1', missedFires: 2, missedRunIds: ['child-run-1', 'child-run-2'] });
    const managerHeartbeat = reminder({ missedFires: 1, missedRunIds: ['manager-run-1'] });
    const { service } = await makeService(observer, [managerHeartbeat, childWatch], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'working', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    await service.store.addMessage({ id: 'explicit-child', to: 'child-1', from: 'manager-1', body: 'keep this explicit message', urgency: 'normal', status: 'pending', createdAt: new Date().toISOString() });
    await service.unsubscribeChildWatch('manager-1', 'child-1', 'no automatic recovery');
    expect(service.store.getMessages().some((message) => message.kind === 'heartbeat-recovery' && message.body.includes('child-1'))).toBe(false);
    expect(service.store.getMessages().some((message) => message.id === 'explicit-child')).toBe(true);
    expect(service.store.findReminder('child-watch-local')?.missedFires).toBe(0);
    service.close();
  });

  it('retires a legacy child watch without rebuilding it when unsubscribe races reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-rebuild-race-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state; await chmod(shim, 0o755);
    const real = new PaseoCli(shim);
    let failDelete = true;
    const cli = { run: async (args: string[], options?: any) => {
      if (failDelete && args[0] === 'heartbeat' && args[1] === 'delete') throw new Error('temporary delete failure');
      return real.run(args, options);
    } };
    const service = new CompanionService(cli as any, new Store(root));
    await service.init();
    await service.store.addManager('manager-1');
    await service.store.addReminder(reminder({ id: 'race-watch', daemonId: 'missing-watch', kind: 'child-watch', watchKind: 'child', subjectChildId: 'child-1' }));
    await Promise.all([service.reconcileReminders(), service.unsubscribeChildWatch('manager-1', 'child-1', 'cancel during retirement')]);
    expect(service.store.findReminder('race-watch')?.status).toBe('active');
    expect((await service.store.getReminders()).filter((r) => r.kind === 'child-watch' && r.daemonId).length).toBe(1);
    failDelete = false; await service.reconcileReminders();
    expect(service.store.findReminder('race-watch')).toEqual(expect.objectContaining({ status: 'active', alive: 'unknown' }));
    expect(service.store.getReminders().filter((r) => r.subjectChildId === 'child-1' && r.status === 'active')).toHaveLength(1);
    service.close();
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
    expect(transient.store.getReminders().filter((r) => r.kind === 'child-watch' && !r.daemonId && r.status === 'active')).toHaveLength(1);
    expect(transient.store.getReminders()).toHaveLength(2);
    expect(transient.store.getLedger()).toHaveLength(0);
    expect((await transient.listChildren('manager-1')).children[0].hasLiveWakeupSource).toBe(true);
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

  it('does not create a generic all-silent fallback during reconciliation', async () => {
    const deadObserver = new DirectPayloadObserver();
    const dead = await makeService(deadObserver, [reminder({ id: 'dead-fallback', daemonId: undefined, name: 'dead-fallback', kind: 'generic', status: 'dead', alive: false })], {
      'manager-1': { id: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
      'child-1': { id: 'child-1', Id: 'child-1', ParentAgentId: 'manager-1', Status: 'completed', UpdatedAt: '2026-08-11T00:00:00Z', Cwd: process.cwd() },
    });
    await dead.service.reconcileOnce();
    expect(dead.service.store.getReminders().filter((item) => item.kind === 'generic' && item.status === 'active')).toHaveLength(0);
    dead.service.close();

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
    await writeFile(path.join(root, 'tracked-children.json'), JSON.stringify({
      'manager-1\0child-clean': { managerId: 'manager-1', childId: 'child-clean', source: 'explicit', addedAt: new Date().toISOString() },
    }));
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
    const heartbeats = await service.listHeartbeats(true);
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

  it('retains active message schedules and only the newest fifty terminal records', async () => {
    const observer = new DirectPayloadObserver();
    const { root, service } = await makeService(observer);
    const schedules = Array.from({ length: 55 }, (_, index) => ({
      id: `terminal-${index}`, recipient: 'manager-1', generation: `g-${index}`, batchIds: [], prompt: `terminal-${index}`,
      status: 'completed' as const, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    schedules.push({ id: 'active-live', recipient: 'manager-1', generation: 'g-active', batchIds: [], prompt: 'active', status: 'active' as const, daemonId: 'daemon-live', createdAt: new Date().toISOString() });
    await writeFile(path.join(root, 'message-schedules.json'), JSON.stringify(schedules));
    service.close();
    const restarted = new CompanionService(new PaseoCli(shim), new Store(root), observer);
    await restarted.init();
    const retained = restarted.store.getMessageSchedules();
    expect(retained).toHaveLength(51);
    expect(retained.some((schedule) => schedule.id === 'terminal-0')).toBe(false);
    expect(retained.some((schedule) => schedule.id === 'terminal-54')).toBe(true);
    expect(retained.find((schedule) => schedule.id === 'active-live')).toEqual(expect.objectContaining({ status: 'active', daemonId: 'daemon-live' }));
    restarted.close();
  });
});
