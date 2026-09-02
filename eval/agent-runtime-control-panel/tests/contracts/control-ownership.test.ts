import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { handleArcp } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp-server.js';
import { ArcpStartupOwnershipError, createServer, ownershipPaths, releaseOwnershipOnSignal, startServer } from '../../../../skills/agent-runtime-control-panel/runtime/src/server.js';

const apps: Array<{ server: http.Server; arcp: ArcpService }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => { await new Promise<void>((resolve) => app.server.close(() => resolve())); app.arcp.close(); })); });

async function app(root: string) { const value = await createServer(root); apps.push(value); return value; }
async function start(root: string) { const value = await app(root); await startServer(value, 0, root); const address = value.server.address(); if (!address || typeof address === 'string') throw new Error('missing ephemeral address'); return { value, base: `http://127.0.0.1:${address.port}` }; }
async function request(base: string, target: string, credential: string, body: Record<string, unknown>) { return fetch(`${base}${target}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-member-key': credential }, body: JSON.stringify(body) }); }

describe('ARCP control-plane ownership', () => {
  it('refuses a duplicate before it can construct a service and write into the owned root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-owner-'));
    const first = await start(root);
    const before = await readdir(root);
    // Ownership is claimed before ArcpService is constructed, so the refused
    // duplicate never runs init()'s identity migration or pump against a data
    // root it is about to be refused.
    await expect(createServer(root)).rejects.toMatchObject({ code: 'arcp_owner_active' } satisfies Partial<ArcpStartupOwnershipError>);
    expect(await readdir(root)).toEqual(before);
    expect(first.value.server.listening).toBe(true);
  });

  it('releases ownership on SIGTERM and reclaims a record whose pid epoch was recycled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-signal-owner-'));
    const record = path.join(root, 'arcp.pid');
    const released: string[] = []; const reraised: string[] = [];
    const unregister = releaseOwnershipOnSignal({ files: [record], updatePort: () => undefined, release: () => released.push('released') }, (signal) => reraised.push(signal));
    process.emit('SIGTERM' as any);
    unregister();
    expect(released).toEqual(['released']);
    expect(reraised).toEqual(['SIGTERM']);
    // A live pid with a different durable start epoch is proven reuse, while a
    // live owner with the matching epoch is still refused.
    await writeFile(record, JSON.stringify({ pid: process.pid, port: 0, dataDir: root }) + '\n');
    await expect(createServer(root)).rejects.toMatchObject({ code: 'arcp_owner_active' } satisfies Partial<ArcpStartupOwnershipError>);
    await writeFile(record, JSON.stringify({ pid: process.pid, port: 0, dataDir: root, processStart: 'definitely-not-this-process' }) + '\n');
    apps.push(await createServer(root));
    expect(JSON.parse(await readFile(record, 'utf8')).dataDir).toBe(root);
  });

  it('keys the ownership record to the data root it protects, not to the runtime dir', async () => {
    const shared = await mkdtemp(path.join(os.tmpdir(), 'arcp-shared-data-'));
    const runtimeA = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-a-'));
    const runtimeB = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-b-'));
    const otherData = await mkdtemp(path.join(os.tmpdir(), 'arcp-other-data-'));
    const previous = process.env.ARCP_RUNTIME_DIR;
    try {
      // Same data root, different runtime dirs: still one owner.
      process.env.ARCP_RUNTIME_DIR = runtimeA;
      apps.push(await createServer(shared));
      expect(ownershipPaths(shared)).toContain(path.join(shared, 'arcp.pid'));
      process.env.ARCP_RUNTIME_DIR = runtimeB;
      await expect(createServer(shared)).rejects.toMatchObject({ code: 'arcp_owner_active' } satisfies Partial<ArcpStartupOwnershipError>);
      // Distinct data roots sharing one runtime dir must not falsely conflict.
      process.env.ARCP_RUNTIME_DIR = runtimeA;
      apps.push(await createServer(otherData));
    } finally { if (previous === undefined) delete process.env.ARCP_RUNTIME_DIR; else process.env.ARCP_RUNTIME_DIR = previous; }
  });

  it('reclaims a stale ownership record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-stale-owner-'));
    await writeFile(path.join(root, 'arcp.pid'), JSON.stringify({ pid: 999999, port: 0 }) + '\n');
    const started = await start(root);
    const owner = JSON.parse(await readFile(path.join(root, 'arcp.pid'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    expect(owner.port).toBe((started.value.server.address() as any).port);
  });

  it('authorizes task creation to the member workspace and excludes Steward analysis identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-task-owner-'));
    const service = new ArcpService(root); await service.init();
    const server = http.createServer(async (req, res) => { if (!(await handleArcp(req, res, service))) { res.statusCode = 404; res.end(); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apps.push({ server, arcp: service });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); const base = `http://127.0.0.1:${address.port}`;
    const { actor } = await service.registerActor({ clientIdentity: 'task-route-owner' });
    const first = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'first' });
    const second = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'second' });
    const worker = await service.joinWorkspace({ workspaceId: first.workspace.id, label: 'worker', role: 'worker' });
    const steward = await service.joinWorkspace({ workspaceId: first.workspace.id, label: 'steward', role: 'steward-analyst' });
    expect((await request(base, `/v1/workspaces/${first.workspace.id}/tasks`, worker.credential!, { title: 'allowed' })).status).toBe(201);
    expect((await request(base, `/v1/workspaces/${second.workspace.id}/tasks`, worker.credential!, { title: 'cross scope' })).status).toBe(404);
    expect((await request(base, `/v1/workspaces/${first.workspace.id}/tasks`, steward.credential!, { title: 'steward product task' })).status).toBe(401);
  });
});
