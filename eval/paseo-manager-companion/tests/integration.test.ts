import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PaseoCli } from '../../../tools/paseo-manager-companion/src/cli.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { createServer } from '../../../tools/paseo-manager-companion/src/server.js';

let running: Awaited<ReturnType<typeof createServer>> | undefined;
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
});
