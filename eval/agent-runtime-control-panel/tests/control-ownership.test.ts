import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { handleArcp } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp-server.js';
import { ArcpStartupOwnershipError, createServer, startServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';

const apps: Array<{ server: http.Server; arcp: ArcpService }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => { await new Promise<void>((resolve) => app.server.close(() => resolve())); app.arcp.close(); })); });

async function app(root: string) { const value = await createServer(root); apps.push(value); return value; }
async function start(root: string) { const value = await app(root); await startServer(value, 0, root); const address = value.server.address(); if (!address || typeof address === 'string') throw new Error('missing ephemeral address'); return { value, base: `http://127.0.0.1:${address.port}` }; }
async function request(base: string, target: string, credential: string, body: Record<string, unknown>) { return fetch(`${base}${target}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-member-key': credential }, body: JSON.stringify(body) }); }

describe('ARCP control-plane ownership', () => {
  it('refuses a second server for an owned root cleanly rather than leaking EADDRINUSE', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-owner-'));
    const first = await start(root);
    const second = await app(root);
    await expect(startServer(second, (first.value.server.address() as any).port, root)).rejects.toMatchObject({ code: 'arcp_owner_active' } satisfies Partial<ArcpStartupOwnershipError>);
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
