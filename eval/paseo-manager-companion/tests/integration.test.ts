import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaseoCli } from '../../../tools/paseo-manager-companion/src/cli.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { createServer } from '../../../tools/paseo-manager-companion/src/server.js';

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
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
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
    expect(watches[0].prompt).not.toContain(childId);
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
    expect(reloaded.getMessages()).toHaveLength(15);
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const active = Object.values(saved.heartbeats).filter((heartbeat: any) => heartbeat.status === 'active');
    expect(active).toHaveLength(1);
    const schedule = active[0] as any;
    expect(schedule.maxRuns).toBe(1);
    expect(schedule.prompt).not.toMatch(/ack/i);
    expect(schedule.prompt.indexOf('message-14')).toBeLessThan(schedule.prompt.indexOf('message-0'));
    expect(posted).toHaveLength(15);
    await new PaseoCli(shim).run(['fire', schedule.id]);
    await service.reconcileOnce();
    expect(service.getMessages()).toHaveLength(0);
    const after = JSON.parse(await readFile(state, 'utf8'));
    expect(after.heartbeats[schedule.id].logs.at(-1).status).toBe('succeeded');
    expect(service.store.getMessageSchedules().every((item) => item.status !== 'active')).toBe(true);
    service.close();
  });

  it('retains a busy batch and rearms it until the recipient has an idle turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-busy-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    const child = await service.spawn({ provider: 'shim', title: 'busy child', cwd: process.cwd(), prompt: 'work' }, 'manager-1');
    const childId = String((child as any).id);
    await service.postMessage({ to: childId, from: 'manager-1', body: 'keep this', urgency: 'normal' });
    let saved = JSON.parse(await readFile(state, 'utf8'));
    let active = Object.values(saved.heartbeats).find((heartbeat: any) => heartbeat.status === 'active') as any;
    await new PaseoCli(shim).run(['fire', active.id]);
    const failedRun = JSON.parse(await readFile(state, 'utf8')).heartbeats[active.id];
    expect(failedRun.status).toBe('completed');
    expect(failedRun.logs.at(-1).status).toBe('failed');
    await service.reconcileOnce();
    expect(service.getMessages(childId)).toHaveLength(1);
    saved = JSON.parse(await readFile(state, 'utf8'));
    expect(Object.values(saved.heartbeats).filter((heartbeat: any) => heartbeat.status === 'active' && heartbeat.target === childId)).toHaveLength(1);
    saved.agents[childId].Status = 'idle';
    await writeFile(state, JSON.stringify(saved));
    active = Object.values(saved.heartbeats).find((heartbeat: any) => heartbeat.status === 'active') as any;
    await new PaseoCli(shim).run(['fire', active.id]);
    await service.reconcileOnce();
    expect(service.getMessages(childId)).toHaveLength(0);
    service.close();
  });

  it('updates one pre-run schedule in place for staggered arrivals and preserves urgent queue order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'companion-messages-staggered-'));
    const shim = fileURLToPath(new URL('../fixtures/paseo-shim.mjs', import.meta.url));
    const state = path.join(root, 'state.json');
    await writeFile(state, JSON.stringify({ agents: {}, heartbeats: {} }));
    process.env.PASEO_SHIM_STATE = state;
    const service = new CompanionService(new PaseoCli(shim), new Store(root));
    await service.init();
    for (let index = 0; index < 15; index++) {
      await service.postMessage({ to: 'manager-1', from: `sender-${index % 3}`, body: `staggered-${index}`, urgency: index === 14 ? 'urgent' : 'normal' });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const active = Object.values(saved.heartbeats).filter((heartbeat: any) => heartbeat.status === 'active');
    expect(active).toHaveLength(1);
    expect((active[0] as any).prompt).toContain('staggered-14');
    expect((active[0] as any).prompt.indexOf('staggered-14')).toBeLessThan((active[0] as any).prompt.indexOf('staggered-0'));
    expect(Object.keys(saved.heartbeats)).toHaveLength(1);
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
    await service.postMessage({ to: 'manager-1', from: 'manager-1', body: 'must retain' });
    const saved = JSON.parse(await readFile(state, 'utf8'));
    const id = Object.keys(saved.heartbeats)[0];
    saved.heartbeats[id].status = 'completed';
    saved.heartbeats[id].logs = [];
    await writeFile(state, JSON.stringify(saved));
    await service.reconcileOnce();
    expect(service.getMessages()).toHaveLength(1);
    expect(Object.values(JSON.parse(await readFile(state, 'utf8')).heartbeats).filter((heartbeat: any) => heartbeat.status === 'active')).toHaveLength(0);
    service.close();
  });
});
