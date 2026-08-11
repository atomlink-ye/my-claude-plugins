import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaseoCli } from '../../../tools/paseo-manager-companion/src/cli.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { createServer } from '../../../tools/paseo-manager-companion/src/server.js';
import { ProcessWaitSourceDetector } from '../../../tools/paseo-manager-companion/src/wait-source.js';

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

describe('HTTP integration through a paseo executable', () => {
  it('exercises every route and enforces ledger/reminder reasons', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    process.env.PASEO_AGENT_ID = 'manager-1';
    await chmod(shim, 0o755);
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    running = await createServer(service);
    await new Promise<void>((resolve) => running!.server.listen(0, '127.0.0.1', resolve));
    const address = running.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await request(base, 'GET', '/health')).status).toBe(200);
    const spawned = await request(base, 'POST', '/spawn', { provider: 'shim', title: 'child', cwd: process.cwd(), prompt: 'work' });
    expect(spawned.status).toBe(201);
    const childId = spawned.body.id;
    const children = await request(base, 'GET', '/children?agentId=manager-1');
    expect(children.status).toBe(200); expect(children.body.children.some((c: any) => c.id === childId)).toBe(true);
    expect((await request(base, 'GET', `/children/${childId}/briefing`)).status).toBe(200);
    const reminder = await request(base, 'POST', '/reminders', { agentId: 'manager-1', delaySeconds: 60, message: 'check' });
    expect(reminder.status).toBe(201);
    expect((await request(base, 'DELETE', `/reminders/${reminder.body.id}`, { reason: 'done' })).status).toBe(200);
    expect((await request(base, 'DELETE', `/reminders/${reminder.body.id}`, {})).status).toBe(400);
    process.env.PASEO_SEND_FAIL = '1';
    const message = await request(base, 'POST', '/messages', { to: 'manager-1', from: 'child-1', body: 'explicit message' });
    delete process.env.PASEO_SEND_FAIL;
    expect(message.status).toBe(201);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, {})).status).toBe(400);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, { reason: 'handled' })).status).toBe(200);
    expect((await request(base, 'DELETE', `/messages/${message.body.id}`, { reason: 'retry handled' })).status).toBe(200);
    expect((await request(base, 'DELETE', '/messages/unknown-message-id', { reason: 'not present' })).status).toBe(404);
    expect((await request(base, 'POST', '/compact-wake', { agentId: 'manager-1', resumeSteps: 'read state; continue' })).status).toBe(202);
    expect((await request(base, 'POST', '/ledger', { type: 'park', target: childId, verdict: 'parked', reason: 'waiting', recovery: 'resume later' })).status).toBe(201);
    expect((await request(base, 'POST', '/ledger', { type: 'park', target: childId, verdict: '', reason: '' })).status).toBe(400);
    const ledger = await request(base, 'GET', `/ledger?target=${childId}`); expect(ledger.status).toBe(200); expect(ledger.body.length).toBe(1);
    expect((await request(base, 'POST', `/ledger/${ledger.body[0].id}/revoke`, { reason: 'resume' })).status).toBe(200);
  });

  it('replays the reverse-check: completed children without a wakeup are ledgered', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-replay-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state; process.env.PASEO_AGENT_ID = 'manager-1';
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'done child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const childId = String((child as any).id);
    saved.agents[childId].Status = 'idle';
    await writeFile(state, JSON.stringify(saved));
    await service.reconcileOnce();
    expect(service.listLedger('known-red', 'manager-1')).toHaveLength(1);
    expect(service.store.getReminders().some((r) => r.status === 'active')).toBe(true);
    service.close();
  });

  it('creates one manager-delivered child watch for an unparked child and none for a parked child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-child-watch-park-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'watched child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
    await service.addLedger({ type: 'park', target: childId, verdict: 'parked', reason: 'waiting' });
    await service.reconcileOnce();
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(0);
    const park = service.listLedger('park', childId)[0] as any;
    await service.revokeLedger(park.id, 'resume');
    await service.reconcileOnce();
    const watches = service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active');
    expect(watches).toHaveLength(1);
    expect(watches[0]).toEqual(expect.objectContaining({ agentId: 'manager-1', subjectChildId: childId, kind: 'child-watch', watchKind: 'child' }));
    expect(watches[0].prompt).toMatch(/query companion health|inspect the relevant child/i);
    expect(watches[0].prompt).toContain(childId);
    expect(watches[0].prompt).toContain('"cwd"');
    service.close();
  });

  it('auto-revokes a park only after a later parseable running activity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-park-resume-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'parked child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
    await service.addLedger({ type: 'park', target: childId, verdict: 'parked', reason: 'waiting' });
    await service.reconcileOnce();
    expect(service.listLedger('park', childId)).toHaveLength(1);
    let saved = JSON.parse(await readFile(state, 'utf8'));
    saved.agents[childId].Status = 'running';
    saved.agents[childId].UpdatedAt = new Date(Date.now() + 10_000).toISOString();
    await writeFile(state, JSON.stringify(saved));
    await service.reconcileOnce();
    expect(service.listLedger('park', childId)).toHaveLength(0);
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(1);
    service.close();
  });

  it('migrates a live pre-P0 child watch to an identified prompt without duplicating it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-migrate-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'old watch child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
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
    const child = await service.spawn({ provider: 'shim', title: 'watched child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
    await service.reconcileOnce();
    await service.reconcileOnce();
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active')).toHaveLength(1);
    expect(Object.keys(saved.heartbeats)).toHaveLength(1);
    service.close();
  });

  it('persists a pair unsubscribe across reconciliation and restart, then restores only that child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-optout-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    const first = await service.spawn({ provider: 'shim', title: 'first', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const second = await service.spawn({ provider: 'shim', title: 'second', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const firstId = String((first as any).id); const secondId = String((second as any).id);
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

  it('acknowledging a child-watch reminder leaves opt-out disabled and reconciliation replaces it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-ack-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root)); await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'ack watch child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
    const watch = await service.createReminder({ agentId: 'manager-1', subjectChildId: childId, kind: 'child-watch', watchKind: 'child', delaySeconds: 300, message: 'watch' });
    await service.store.updateReminder(watch.id, { missedFires: 2, missedRunIds: ['ack-run'] });
    await service.deleteReminder(watch.id, 'acknowledged');
    expect(service.store.isChildWatchOptedOut('manager-1', childId)).toBe(false);
    expect(service.store.findReminder(watch.id)?.status).toBe('deleted');
    expect(service.store.findReminder(watch.id)?.missedFires).toBe(0);
    await service.reconcileOnce();
    const active = service.store.getReminders().filter((r) => r.subjectChildId === childId && r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(watch.id);
    service.close();
  });

  it('serializes unsubscribe with ensure so a concurrent reconcile cannot leave a new watch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-watch-race-'));
    const state = path.join(root, 'state.json'); await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const detector = { detect: async () => false };
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root), undefined, detector); await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'race child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
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
    const child = await service.spawn({ provider: 'shim', title: 'corrupt optout child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
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
    const child = await service.spawn({ provider: 'shim', title: 'waited child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
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
      const child = await service.spawn({ provider: 'shim', title: 'matrix child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
      await service.reconcileOnce();
      return { service, childId: String((child as any).id), detector };
    };
    const waitOnly = await make(true);
    expect((await waitOnly.service.listChildren('manager-1')).children[0]).toEqual(expect.objectContaining({ hasLivePaseoWait: true, hasLiveCompanionWatch: false, hasLiveWakeupSource: true }));
    expect(waitOnly.service.store.getReminders().filter((r) => r.kind === 'child-watch' && r.status === 'active')).toHaveLength(0);
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
    for (const n of [1, 2, 3]) children.push(await service.spawn({ provider: 'shim', title: `child ${n}`, cwd: process.cwd(), prompt: 'work' }, 'manager-1'));
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

  it('coalesces a burst into one real one-shot run and removes only its successful batch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const posted = await Promise.all(Array.from({ length: 15 }, (_, index) => service.postMessage({ to: 'manager-1', from: `sender-${index % 3}`, body: `message-${index}`, urgency: index === 14 ? 'urgent' : 'normal' })));
    const reloaded = new Store(root);
    await reloaded.init();
    expect(reloaded.getMessages()).toHaveLength(0);
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(saved.sends).toHaveLength(1);
    const delivery = saved.sends[0];
    expect(delivery.args).toEqual(['send', '--no-wait', '--json', 'manager-1', expect.any(String)]);
    expect(delivery.prompt).toContain(`id=${posted[0].id}`);
    expect(delivery.prompt).not.toContain('/messages/');
    expect(delivery.prompt.indexOf('message-14')).toBeLessThan(delivery.prompt.indexOf('message-0'));
    expect(posted).toHaveLength(15);
    expect(posted.every((message) => message.schedule === null && message.delivery?.status === 'accepted' && message.delivery.transport === 'paseo-send')).toBe(true);
    expect(service.getMessages()).toHaveLength(0);
    expect(service.store.getMessageSchedules().every((item) => item.status !== 'active' && !item.daemonId)).toBe(true);
    expect(await service.deleteMessage(posted[0].id, 'already delivered')).toEqual({ id: posted[0].id, status: 'deleted', retirementPending: false });
    await expect(service.deleteMessage('unknown-message-id', 'not present')).rejects.toThrow('message not found');
    service.close();
  });

  it('retains a failed send and retries it on reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-busy-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    process.env.PASEO_SEND_FAIL = '1';
    const posted = await service.postMessage({ to: 'manager-1', from: 'manager-1', body: 'keep this', urgency: 'normal' });
    expect(posted.status).toBe('pending');
    expect(posted.schedule).toBeNull();
    expect(posted.delivery).toEqual(expect.objectContaining({ transport: 'paseo-send', status: 'pending', acceptedAt: null }));
    expect(service.store.getMessageSchedules().at(-1)?.status).toBe('failed');
    expect(service.getMessages()).toHaveLength(1);
    delete process.env.PASEO_SEND_FAIL;
    await service.reconcileOnce();
    expect(service.getMessages()).toHaveLength(0);
    expect(JSON.parse(await readFile(state, 'utf8')).sends).toHaveLength(1);
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

  it('does not claim acceptance when send status is false', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-message-delete-retry-'));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(paseoShim), new Store(root));
    await service.init();
    process.env.PASEO_SEND_STATUS = 'false';
    const message = await service.postMessage({ to: 'manager-1', from: 'sender', body: 'retain this' });
    expect(message.status).toBe('pending');
    expect(service.store.getMessageSchedules().at(-1)?.status).toBe('failed');
    expect(service.getMessages()).toHaveLength(1);
    delete process.env.PASEO_SEND_STATUS;
    await service.reconcileOnce();
    expect(service.getMessages()).toHaveLength(0);
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

  it('does not duplicate an accepted send when local cleanup fails once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-recovery-receipt-retry-'));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const store = new Store(root);
    const removeMessages = store.removeMessages.bind(store);
    vi.spyOn(store, 'removeMessages').mockRejectedValueOnce(new Error('disk unavailable')).mockImplementation(removeMessages);
    const service = new CompanionService(new PaseoCli(paseoShim), store);
    await service.init();
    const recovery = await service.postMessage({ to: 'manager-1', from: 'companion', body: 'attempt once' });
    expect(recovery.status).toBe('delivered');
    expect(service.store.getMessageSchedules().at(-1)?.status).toBe('completed');
    expect(service.getMessages().some((item) => item.id === recovery.id)).toBe(true);
    await service.reconcileOnce();
    expect(JSON.parse(await readFile(state, 'utf8')).sends).toHaveLength(1);
    expect(service.getMessages().some((item) => item.id === recovery.id)).toBe(false);
    service.close();
  });

  it('coalesces only concurrent arrivals and preserves urgent queue order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-staggered-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    for (let index = 0; index < 15; index++) {
      void service.postMessage({ to: 'manager-1', from: `sender-${index % 3}`, body: `staggered-${index}`, urgency: index === 14 ? 'urgent' : 'normal' });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const saved = JSON.parse(await readFile(state, 'utf8'));
    expect(saved.sends).toHaveLength(1);
    expect(saved.sends[0].prompt).toContain('staggered-14');
    expect(saved.sends[0].prompt.indexOf('staggered-14')).toBeLessThan(saved.sends[0].prompt.indexOf('staggered-0'));
    service.close();
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
    expect(JSON.parse(await readFile(state, 'utf8')).sends ?? []).toHaveLength(1);
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
    expect(saved.sends).toHaveLength(1);
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
    await service.postMessage({ to: 'manager-1', from: 'sender', body: 'accepted' });
    process.env.PASEO_SEND_FAIL = '1';
    await service.postMessage({ to: 'manager-1', from: 'sender', body: 'failed' });
    const acceptedRecord = JSON.parse(String(accepted.mock.calls.at(-1)?.[0]));
    const failedRecord = JSON.parse(String(failed.mock.calls.at(-1)?.[0]));
    expect(acceptedRecord).toEqual(expect.objectContaining({ type: 'message-delivery-accepted', recipient: 'manager-1', transport: 'paseo-send', generation: expect.any(String), batchIds: expect.any(Array) }));
    expect(failedRecord).toEqual(expect.objectContaining({ type: 'message-delivery-failed', recipient: 'manager-1', transport: 'paseo-send', generation: expect.any(String), batchIds: expect.any(Array) }));
    accepted.mockRestore(); failed.mockRestore(); service.close();
  });
});
