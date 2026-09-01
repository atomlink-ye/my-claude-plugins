import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaseoCli } from '../../../skills/agent-runtime-control-panel/runtime/src/cli.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { ProcessWaitSourceDetector } from '../../../skills/agent-runtime-control-panel/runtime/src/wait-source.js';

let running: Awaited<ReturnType<typeof createServer>> | undefined;
const paseoShim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
beforeEach(async () => { await chmod(paseoShim, 0o755); process.env.PASEO_AGENT_ID = 'manager-1'; });
afterEach(async () => {
  if (running) { running.service.close(); await new Promise<void>((resolve) => running!.server.close(() => resolve())); }
  running = undefined;
  delete process.env.PASEO_SHIM_STATE;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_CONCURRENCY_STATE;
  delete process.env.PASEO_CONCURRENCY_FAIL;
  delete process.env.PASEO_DELETE_TRANSIENT;
  delete process.env.PASEO_SCHEDULE_MUTATION_TRANSIENT;
  delete process.env.PASEO_SEND_FAIL;
  delete process.env.PASEO_SEND_STATUS;
});

async function request(base: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as any };
}

async function createChild(shim: string, title: string, managerId = 'manager-1'): Promise<Record<string, any>> {
  const value = await new PaseoCli(shim).run([
    'run', '-d', '--provider', 'shim', '--title', title, '--cwd', process.cwd(), '--json', 'work',
  ], { agentId: managerId });
  const result = value.value as Record<string, any>;
  return { ...result, id: result.agentId ?? result.id };
}

describe('HTTP integration through a paseo executable', () => {
  it('exercises every route and enforces ledger/reminder reasons', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {
      'pre-start-child': { id: 'pre-start-child', Id: 'pre-start-child', ParentAgentId: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-08T00:00:00.000Z', Cwd: process.cwd() },
    }, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    process.env.PASEO_AGENT_ID = 'manager-1';
    await chmod(shim, 0o755);
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    running = await createServer(service);
    await new Promise<void>((resolve) => running!.server.listen(0, '127.0.0.1', resolve));
    const address = running.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await request(base, 'GET', '/health')).status).toBe(200);
    expect((await request(base, 'POST', '/spawn', { agentId: 'manager-1', provider: 'shim', title: 'child', cwd: process.cwd(), prompt: 'work' })).status).toBe(404);
    const spawned = await createChild(shim, 'child');
    const childId = spawned.id;
    expect((await request(base, 'PUT', `/children/${childId}?agentId=manager-1`)).status).toBe(200);
    const children = await request(base, 'GET', '/children?agentId=manager-1');
    expect(children.status).toBe(200); expect(children.body.children.some((c: any) => c.id === childId)).toBe(true);
    expect(children.body.children.some((c: any) => c.id === 'pre-start-child')).toBe(true);
    expect(children.body.children.find((c: any) => c.id === 'pre-start-child')?.tracked).toBe(false);
    expect(children.body.children.find((c: any) => c.id === childId)?.trackedSource).toBe('explicit');
    expect((await request(base, 'GET', `/children/${childId}/briefing`)).status).toBe(200);
    const reminder = await request(base, 'POST', '/reminders', { agentId: 'manager-1', delaySeconds: 60, message: 'check' });
    expect(reminder.status).toBe(201);
    expect(reminder.body).toEqual(expect.objectContaining({ schedulingKind: 'once', nextRunAt: expect.any(String) }));
    const queryIdentityReminder = await request(base, 'POST', '/reminders?agentId=manager-1', { delaySeconds: 60, message: 'query identity' });
    expect(queryIdentityReminder.status).toBe(201);
    const invalidMode = await request(base, 'POST', '/reminders', { agentId: 'manager-1', mode: 'eventually', message: 'zombie' });
    expect(invalidMode).toEqual({ status: 400, body: { error: 'mode must be once or repeat', code: 'invalid_value', field: 'mode', allowed: ['once', 'repeat'] } });
    const customId = await request(base, 'POST', '/reminders', { id: 'my-custom-id', agentId: 'manager-1', delaySeconds: 60, message: 'custom' });
    expect(customId).toEqual({ status: 400, body: { error: 'caller-supplied reminder id is not supported', code: 'invalid_value', field: 'id' } });
    const listedReminders = await request(base, 'GET', '/reminders?agentId=manager-1');
    expect(listedReminders.status).toBe(200); expect(listedReminders.body.some((item: any) => item.id === reminder.body.id)).toBe(true);
    expect(listedReminders.body.some((item: any) => item.kind === 'child-watch' && item.schedulingKind === 'in-process' && item.nextRunAt === undefined)).toBe(true);
    const exactReminder = await request(base, 'GET', `/reminders/${reminder.body.id}`);
    expect(exactReminder.status).toBe(200); expect(exactReminder.body).toEqual(expect.objectContaining({ id: reminder.body.id, mode: 'once', status: 'active' }));
    expect((await request(base, 'GET', '/reminders/unknown-reminder-id')).status).toBe(404);
    expect((await request(base, 'DELETE', `/reminders/${reminder.body.id}`, { reason: 'done' })).status).toBe(200);
    expect((await request(base, 'DELETE', `/reminders/${reminder.body.id}`, {})).status).toBe(400);
    const message = await request(base, 'POST', '/messages', { to: 'manager-1', from: 'child-1', body: 'explicit message' });
    expect(message.status).toBe(201);
    const visibleBeforeAck = await request(base, 'GET', '/messages?to=manager-1');
    expect(visibleBeforeAck.status).toBe(200);
    expect(visibleBeforeAck.body.some((item: any) => item.id === message.body.id && item.status === 'pending')).toBe(true);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, {})).status).toBe(400);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, { reason: 'handled' })).status).toBe(200);
    const absentAfterAck = await request(base, 'GET', '/messages?to=manager-1');
    expect(absentAfterAck.body.some((item: any) => item.id === message.body.id)).toBe(false);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, { reason: 'retry handled' })).status).toBe(200);
    expect((await request(base, 'DELETE', '/messages/unknown-message-id', { reason: 'not present' })).status).toBe(404);
    const notify = await request(base, 'POST', '/messages', { to: 'manager-1', from: 'child-1', body: 'auto clear', delivery: 'interrupt', mode: 'notify' });
    expect(notify.status).toBe(201);
    expect((await request(base, 'DELETE', `/messages/${notify.body.id}`, { reason: 'cleanup' })).body).toEqual({ id: notify.body.id, status: 'deleted', retirementPending: false });
    const ackMessage = await request(base, 'POST', '/messages', { to: 'manager-1', from: 'child-1', body: 'acknowledge me', delivery: 'interrupt', mode: 'ack' });
    expect(ackMessage.status).toBe(201);
    const acknowledged = await request(base, 'DELETE', `/messages/${ackMessage.body.id}`, { reason: 'processed' });
    expect(acknowledged.body.status).toBe('acknowledged');
    const acknowledgedRows = await request(base, 'GET', '/messages?status=acknowledged');
    expect(acknowledgedRows.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: ackMessage.body.id, acknowledgementReason: 'processed' })]));
    expect((await request(base, 'POST', '/compact-wake', { agentId: 'manager-1', compact: 'summarize progress', wake: 'read state; continue' })).status).toBe(202);
    expect((await request(base, 'POST', '/ledger', { type: 'park', target: childId, verdict: 'parked', reason: 'waiting', recovery: 'resume later' })).status).toBe(201);
    expect((await request(base, 'POST', '/ledger', { type: 'park', target: childId, verdict: '', reason: '' })).status).toBe(400);
    expect(await request(base, 'POST', '/ledger', { type: 'later', target: childId, verdict: 'x', reason: 'x' })).toEqual({
      status: 400, body: { error: 'type must be park, known-red, or deferred', code: 'invalid_value', field: 'type', allowed: ['park', 'known-red', 'deferred'] },
    });
    const ledger = await request(base, 'GET', `/ledger?target=${childId}`); expect(ledger.status).toBe(200); expect(ledger.body.length).toBe(1);
    expect((await request(base, 'POST', `/ledger/${ledger.body[0].id}/revoke`, { reason: 'resume' })).status).toBe(200);
  });

  it('migrates a live pre-P0 child watch to an identified prompt without duplicating it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-migrate-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await createChild(shim, 'old watch child');
    const childId = String((child as any).id);
    await service.resubscribeChildWatch('manager-1', childId, 'explicit test tracking');
    process.env.PASEO_DELETE_TRANSIENT = '1';
    const old = await service.createReminder({ agentId: 'manager-1', subjectChildId: childId, kind: 'child-watch', watchKind: 'child', delaySeconds: 300, message: 'old', context: { watchKind: 'child' } });
    await service.store.updateReminder(old.id, { prompt: 'old prompt\nStructured context: {"watchKind":"child"}' });
    await service.reconcileOnce();
    const active = service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active');
    expect(active).toHaveLength(2);
    expect(active.filter((r) => r.prompt.includes(childId) && r.prompt.includes('"cwd"'))).toHaveLength(1);
    expect(active.some((r) => r.prompt.startsWith('old prompt'))).toBe(true);
    await service.reconcileOnce();
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(2);
    service.close();
  });

  it('keeps child-watch reconciliation idempotent across two passes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-child-watch-idempotent-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await createChild(shim, 'watched child');
    const childId = String((child as any).id);
    await service.resubscribeChildWatch('manager-1', childId, 'explicit test tracking');
    await service.reconcileOnce();
    await service.reconcileOnce();
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(1);
    expect(Object.keys(saved.heartbeats)).toHaveLength(0);
    service.close();
  });

  it('persists a pair unsubscribe across reconciliation and restart, then restores only that child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-optout-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    const first = await createChild(paseoShim, 'first');
    const second = await createChild(paseoShim, 'second');
    const firstId = String((first as any).id); const secondId = String((second as any).id);
    await service.resubscribeChildWatch('manager-1', firstId, 'explicit test tracking');
    await service.resubscribeChildWatch('manager-1', secondId, 'explicit test tracking');
    await service.reconcileOnce();
    const unsubscribed = await service.unsubscribeChildWatch('manager-1', firstId, 'no longer waiting');
    expect(unsubscribed).toEqual(expect.objectContaining({ status: 'unsubscribed', retirementPending: false }));
    await service.reconcileOnce();
    expect(service.store.getReminders().filter((r) => r.subjectChildId === firstId && r.status === 'active')).toHaveLength(0);
    expect(service.store.getReminders().filter((r) => r.subjectChildId === secondId && r.status === 'active')).toHaveLength(1);
    service.close();
    const restarted = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await restarted.init(); await restarted.reconcileOnce();
    expect(restarted.store.getReminders().filter((r) => r.subjectChildId === firstId && r.status === 'active')).toHaveLength(0);
    await restarted.resubscribeChildWatch('manager-1', firstId, 'watch again');
    expect(restarted.store.getReminders().filter((r) => r.subjectChildId === firstId && r.status === 'active')).toHaveLength(1);
    expect(restarted.store.getReminders().filter((r) => r.subjectChildId === secondId && r.status === 'active')).toHaveLength(1);
    restarted.close();
  });

  it('acknowledging a child-watch reminder persists opt-out and reconciliation never replaces it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-ack-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root)); await service.init();
    const child = await createChild(paseoShim, 'ack watch child');
    const childId = String((child as any).id);
    const watch = await service.createReminder({ agentId: 'manager-1', subjectChildId: childId, kind: 'child-watch', watchKind: 'child', delaySeconds: 300, message: 'watch' });
    await service.store.updateReminder(watch.id, { missedFires: 2, missedRunIds: ['ack-run'] });
    await service.deleteReminder(watch.id, 'acknowledged');
    expect(service.store.isChildWatchOptedOut('manager-1', childId)).toBe(true);
    expect(service.store.findReminder(watch.id)?.status).toBe('deleted');
    expect(service.store.findReminder(watch.id)?.missedFires).toBe(0);
    await service.reconcileOnce();
    const active = service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active');
    expect(active).toHaveLength(0);
    service.close();
    const restarted = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await restarted.init(); await restarted.reconcileOnce();
    expect(restarted.store.isChildWatchOptedOut('manager-1', childId)).toBe(true);
    expect(restarted.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(0);
    restarted.close();
  });

  it('serializes unsubscribe with ensure so a concurrent reconcile cannot leave a new watch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-race-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const detector = { detect: async () => false };
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root), undefined, detector); await service.init();
    const child = await createChild(paseoShim, 'race child');
    const childId = String((child as any).id);
    await Promise.all([service.reconcileOnce(), service.unsubscribeChildWatch('manager-1', childId, 'race')]);
    await service.reconcileOnce();
    expect(service.store.isChildWatchOptedOut('manager-1', childId)).toBe(true);
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(0);
    service.close();
  });

  it('keeps a corrupt opt-out file fail-closed across restart and rejects mutations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-corrupt-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    await writeFile(path.join(root, 'child-watch-opt-outs.json'), '{not-json');
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root)); await service.init();
    const child = await createChild(paseoShim, 'corrupt optout child');
    const childId = String((child as any).id); await service.reconcileOnce();
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(0);
    await expect(service.unsubscribeChildWatch('manager-1', childId, 'should fail closed')).rejects.toThrow(/opt-out state corrupt/);
    await expect(service.resubscribeChildWatch('manager-1', childId)).rejects.toThrow(/opt-out state corrupt/);
    service.close();
  });

  it('recognizes a real full-id paseo wait and does not add a companion watch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-wait-source-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await createChild(shim, 'waited child');
    const childId = String((child as any).id);
    const waitPaseo = fileURLToPath(new URL('../fixtures/paseo', import.meta.url));
    await chmod(waitPaseo, 0o755);
    const waitProcess = spawn(waitPaseo, ['wait', childId, '--timeout', '1800']);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const detector = new ProcessWaitSourceDetector();
      let detected = false;
      for (let attempt = 0; attempt < 5 && !detected; attempt++) {
        detected = await detector.detect(childId) === true;
        if (!detected) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(detected).toBe(true);
      expect(await detector.detect(`${childId}-near-prefix`)).toBe(false);
      await service.reconcileOnce();
      expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(0);
    } finally {
      waitProcess.kill();
      service.close();
    }
  });

  it('reports the live-source matrix for wait-only, companion-only, and aggregate sources', async () => {
    const make = async (wait: boolean) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'companion-source-matrix-'));
      const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
      process.env.PASEO_SHIM_STATE = state;
      const detector = { live: wait, detect: async () => detector.live as boolean };
      const service = new CompanionService(new PaseoCli(paseoShim), new Store(root), undefined, detector);
      await service.init();
      const child = await createChild(paseoShim, 'matrix child');
      await service.resubscribeChildWatch('manager-1', String((child as any).id), 'explicit test tracking');
      await service.reconcileOnce();
      return { service, childId: String((child as any).id), detector };
    };
    const waitOnly = await make(true);
    expect((await waitOnly.service.listChildren('manager-1')).children[0]).toEqual(expect.objectContaining({ hasLivePaseoWait: true, hasLiveCompanionWatch: true, hasLiveWakeupSource: true, source: 'explicit', addedAt: expect.any(String) }));
    const forced = await waitOnly.service.resubscribeChildWatch('manager-1', waitOnly.childId, 'operator override');
    expect(forced.watch).not.toBeNull();
    expect((await waitOnly.service.listChildren('manager-1')).children[0]).toEqual(expect.objectContaining({ hasLivePaseoWait: true, hasLiveCompanionWatch: true }));
    waitOnly.service.close();
    const companionOnly = await make(false);
    expect((await companionOnly.service.listChildren('manager-1')).children[0]).toEqual(expect.objectContaining({ hasLivePaseoWait: false, hasLiveCompanionWatch: true, hasLiveWakeupSource: true }));
    expect(companionOnly.service.store.getReminders().filter((r) => r.subjectChildId === companionOnly.childId && r.status === 'active')).toHaveLength(1);
    companionOnly.detector.live = true;
    expect((await companionOnly.service.listChildren('manager-1')).children[0]).toEqual(expect.objectContaining({ hasLivePaseoWait: true, hasLiveCompanionWatch: true, hasLiveWakeupSource: true }));
    companionOnly.service.close();
  });

  it('gives the manager an independent watch for each child when one is idle and others run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-child-watch-mixed-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const children = [];
    for (const n of [1, 2, 3]) children.push(await createChild(shim, `child ${n}`));
    for (const child of children) await service.resubscribeChildWatch('manager-1', String((child as any).id), 'explicit test tracking');
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const idleId = String((children[0] as any).id);
    saved.agents[idleId].Status = 'idle';
    await writeFile(state, JSON.stringify(saved));
    await service.reconcileOnce();
    const watches = service.store.getReminders().filter((r) => r.kind === 'child-watch' && r.status === 'active');
    expect(watches).toHaveLength(3);
    expect(new Set(watches.map((r) => r.subjectChildId))).toEqual(new Set(children.map((child) => String((child as any).id))));
    expect(watches.every((r) => r.agentId === 'manager-1')).toBe(true);
    service.close();
  });

  it('keeps all children visible when inspect fan-out exceeds the CLI concurrency threshold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-concurrency-'));
    const shim = fileURLToPath(new URL('../fixtures/concurrency-shim.mjs', import.meta.url));
    await chmod(shim, 0o755);
    process.env.PASEO_CONCURRENCY_STATE = root;
    const service = new CompanionService(new PaseoCli(shim, 2_000), new Store(root));
    await service.init();
    const result = await service.listChildren('manager-1');
    expect(result.children).toHaveLength(20);
    expect(result.partial).toBe(false);
    expect(result.failedCandidates).toHaveLength(0);
    service.close();
  });

  it('reports a candidate after one inspect retry still fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-retry-'));
    const shim = fileURLToPath(new URL('../fixtures/concurrency-shim.mjs', import.meta.url));
    await chmod(shim, 0o755);
    process.env.PASEO_CONCURRENCY_STATE = root;
    process.env.PASEO_CONCURRENCY_FAIL = 'candidate-20';
    const service = new CompanionService(new PaseoCli(shim, 2_000), new Store(root));
    await service.init();
    const result = await service.listChildren('manager-1');
    expect(result.children).toHaveLength(19);
    expect(result.partial).toBe(true);
    expect(result.failedCandidates).toEqual([expect.objectContaining({ id: 'candidate-20', category: 'cli-error' })]);
    service.close();
  });

  it('caches known non-child parents while refreshing known children on the next listing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-parent-cache-'));
    const inspectCalls: string[] = [];
    const cli = {
      run: async (args: string[]) => {
        if (args[0] === 'ls') return { value: [{ id: 'other-1' }, { id: 'child-1' }], stdout: '', stderr: '' };
        if (args[0] === 'inspect') {
          inspectCalls.push(args[1]);
          const parent = args[1] === 'child-1' ? 'manager-1' : null;
          return { value: { Id: args[1], ParentAgentId: parent, Status: 'working' }, stdout: '', stderr: '' };
        }
        return { value: {}, stdout: '', stderr: '' };
      },
    };
    await writeFile(path.join(root, 'tracked-children.json'), JSON.stringify({
      'manager-1\0child-1': { managerId: 'manager-1', childId: 'child-1', source: 'explicit', addedAt: new Date().toISOString() },
    }));
    const service = new CompanionService(cli as any, new Store(root), undefined, { detect: async () => false });
    await service.init();
    expect((await service.listChildren('manager-1')).children).toHaveLength(1);
    expect((await service.listChildren('manager-1')).children).toHaveLength(1);
    expect(inspectCalls).toEqual(['other-1', 'child-1', 'child-1']);
    service.close();
  });

  it('does not conclude all children are done when the child listing is partial', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-partial-'));
    const shim = fileURLToPath(new URL('../fixtures/partial-shim.mjs', import.meta.url));
    await chmod(shim, 0o755);
    const service = new CompanionService(new PaseoCli(shim, 2_000), new Store(root));
    await service.init();
    const first = await service.listChildren('manager-1');
    expect(first.partial).toBe(true);
    expect(first.children.every((child) => child.status === 'idle')).toBe(true);
    await service.reconcileOnce();
    expect(service.listLedger('known-red', 'manager-1')).toHaveLength(0);
    expect(service.store.getReminders()).toHaveLength(0);
    service.close();
  });

  it('deletes one queued message while preserving the other batch item', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-message-delete-'));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    process.env.PASEO_SEND_FAIL = '1';
    const first = await service.postMessage({ to: 'manager-1', from: 'sender', body: 'remove me' });
    const second = await service.postMessage({ to: 'manager-1', from: 'sender', body: 'keep me' });
    delete process.env.PASEO_SEND_FAIL;
    const result = await service.deleteMessage(first.id, 'no longer needed');
    expect(result).toEqual(expect.objectContaining({ id: first.id, status: 'deleted', retirementPending: false }));
    expect(service.getMessages().map((message) => message.id)).toEqual([second.id]);
    expect(service.getMessages().map((message) => message.id)).toEqual([second.id]);
    service.close();
  });

  it('retains every live message schedule and only the newest 50 terminal records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-message-prune-'));
    const terminal = Array.from({ length: 60 }, (_, index) => ({
      id: `terminal-${index}`,
      recipient: 'manager-1',
      generation: `generation-${index}`,
      batchIds: [],
      prompt: 'done',
      status: index % 2 ? 'completed' : 'deleted',
      createdAt: new Date(Date.UTC(2026, 7, 11, 0, index)).toISOString(),
    }));
    const live = { id: 'live', recipient: 'manager-1', generation: 'live', batchIds: [], prompt: 'live', status: 'active', createdAt: '2026-08-10T00:00:00.000Z' };
    await writeFile(path.join(root, 'message-schedules.json'), JSON.stringify([...terminal, live]));
    const store = new Store(root);
    await store.init();
    expect(store.getMessageSchedules()).toHaveLength(51);
    expect(store.getMessageSchedules().some((item) => item.id === 'live')).toBe(true);
    expect(store.getMessageSchedules().some((item) => item.id === 'terminal-59')).toBe(true);
    expect(store.getMessageSchedules().some((item) => item.id === 'terminal-0')).toBe(false);
  });

  it('does not infer delivery from a completed wrapper with no terminal run log', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-empty-log-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    process.env.PASEO_SEND_STATUS = 'false';
    await service.postMessage({ to: 'manager-1', from: 'manager-1', body: 'must retain' });
    expect(JSON.parse(await readFile(state, 'utf8')).sends ?? []).toHaveLength(0);
    service.close();
  });

  it('migrates legacy message heartbeats with heartbeat delete and retries drift before send', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-message-migration-'));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: { 'legacy-daemon': { id: 'legacy-daemon', status: 'active', logs: [] } } }));
    process.env.PASEO_SHIM_STATE = state;
    await writeFile(path.join(root, 'messages.json'), JSON.stringify([{ id: 'legacy-message', to: 'manager-1', from: 'child', body: 'legacy', urgency: 'normal', status: 'pending', createdAt: new Date().toISOString() }]));
    await writeFile(path.join(root, 'message-schedules.json'), JSON.stringify([{ id: 'legacy-local', recipient: 'manager-1', generation: 'legacy-generation', daemonId: 'legacy-daemon', batchIds: ['legacy-message'], prompt: 'legacy', status: 'active', createdAt: new Date().toISOString() }]));
    process.env.PASEO_DELETE_TRANSIENT = '1';
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    expect(JSON.parse(await readFile(state, 'utf8')).sends ?? []).toHaveLength(0);
    expect(service.store.getMessageSchedules()[0].status).toBe('active');
    delete process.env.PASEO_DELETE_TRANSIENT;
    await service.reconcileOnce();
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(saved.sends ?? []).toHaveLength(0);
    expect(saved.heartbeats['legacy-daemon'].status).toBe('deleted');
    expect(service.store.getMessageSchedules()[0]).toEqual(expect.objectContaining({ status: 'deleted' }));
    expect(service.store.getMessageSchedules()[0].daemonId).toBeUndefined();
    service.close();
  });

  it('emits accepted and failed delivery records with generation and batch probes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-message-logs-'));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const accepted = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const failed = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    await service.postMessage({ to: 'manager-1', from: 'sender', body: 'accepted', immediate: true });
    process.env.PASEO_SEND_FAIL = '1';
    await service.postMessage({ to: 'manager-1', from: 'sender', body: 'failed', immediate: true });
    const acceptedRecord = JSON.parse(String(accepted.mock.calls.at(-1)?.[0]));
    const failedRecord = JSON.parse(String(failed.mock.calls.at(-1)?.[0]));
    expect(acceptedRecord).toEqual(expect.objectContaining({ type: 'message-delivery-accepted', recipient: 'manager-1', transport: 'paseo-send', generation: expect.any(String), batchIds: expect.any(Array) }));
    expect(failedRecord).toEqual(expect.objectContaining({ type: 'message-delivery-failed', recipient: 'manager-1', transport: 'paseo-send', generation: expect.any(String), batchIds: expect.any(Array) }));
    accepted.mockRestore(); failed.mockRestore(); service.close();
  });
});
