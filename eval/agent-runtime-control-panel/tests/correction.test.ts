import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';

const apps: Array<{ server: ReturnType<typeof createServer> extends Promise<infer T> ? T['server'] : never; service: CompanionService }> = [];

async function app() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-correction-'));
  const store = new Store(dir);
  const service = new CompanionService({ run: async () => ({ value: [] }) } as any, store);
  const created = await createServer(service);
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  apps.push({ server: created.server, service });
  const address = created.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  while (apps.length) {
    const current = apps.pop()!;
    current.service.close();
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
  }
});

describe('correction gate API', () => {
  it('creates an instance and requires a note for REFUSE', async () => {
    const { base } = await app();
    const created = await fetch(`${base}/corrections`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ managerId: 'manager-1', auditorId: 'auditor-1', findings: [{ id: 'finding-1', text: 'Do the main path' }] }),
    });
    expect(created.status).toBe(201);
    const instance = await created.json();
    expect(instance).toMatchObject({ managerId: 'manager-1', status: 'open' });
    const refused = await fetch(`${base}/corrections/${instance.id}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: 'finding-1', resolution: 'REFUSE' }),
    });
    expect(refused.status).toBe(400);
  });

  it('closes automatically after every finding is resolved and gates open/closed', async () => {
    const { base } = await app();
    const created = await fetch(`${base}/corrections`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ managerId: 'manager-2', auditorId: 'auditor-2', findings: [{ id: 'f1', text: 'first' }, { id: 'f2', text: 'second' }] }),
    });
    const instance = await created.json();
    const openGate = await (await fetch(`${base}/gate?managerId=manager-2`)).json();
    expect(openGate).toMatchObject({ blocked: true });
    expect(openGate.openInstances).toHaveLength(1);
    expect(openGate.openInstances[0].id).toBe(instance.id);

    for (const findingId of ['f1', 'f2']) {
      const resolved = await fetch(`${base}/corrections/${instance.id}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ findingId, verdict: 'ACCEPT' }),
      });
      expect(resolved.status).toBe(200);
    }
    const closed = await (await fetch(`${base}/gate?managerId=manager-2`)).json();
    expect(closed).toMatchObject({ blocked: false, openInstances: [] });
    expect((await (await fetch(`${base}/corrections?managerId=manager-2&status=closed`)).json())[0].status).toBe('closed');
  });
});
