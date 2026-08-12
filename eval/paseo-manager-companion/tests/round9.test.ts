import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionService } from '../../../tools/paseo-manager-companion/src/service.js';
import { createServer } from '../../../tools/paseo-manager-companion/src/server.js';
import { Store } from '../../../tools/paseo-manager-companion/src/store.js';

class Round9Cli {
  agents: Record<string, any> = {};
  calls: string[][] = [];
  prompts: string[] = [];
  async run(args: string[]): Promise<any> {
    this.calls.push(args);
    if (args[0] === 'ls') return { value: Object.values(this.agents).map((a) => ({ id: a.id })) };
    if (args[0] === 'inspect') return { value: this.agents[args[1]] ?? {} };
    if (args[0] === 'heartbeat' && args[1] === 'create') {
      this.prompts.push(args[2]); return { value: { id: `hb-${this.prompts.length}`, status: 'active' } };
    }
    if (args[0] === 'heartbeat' && args[1] === 'delete') return { value: { id: args[2], status: 'deleted' } };
    if (args[0] === 'schedule' && args[1] === 'inspect') return { value: { id: args[2], status: 'active' } };
    if (args[0] === 'schedule' && args[1] === 'logs') return { value: [] };
    return { value: {} };
  }
}

async function makeService(wait: boolean | 'unknown' = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round9-'));
  const store = new Store(dir); await store.init();
  const cli = new Round9Cli();
  cli.agents = { child: { id: 'child', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString(), Cwd: process.cwd() } };
  const detector = { detect: async () => wait };
  const service = new CompanionService(cli as any, store, undefined, detector);
  await store.addManager('manager-1'); await store.trackChild('manager-1', 'child', 'explicit');
  return { dir, store, cli, service };
}

describe('round9 local polling and snapshot watchdog', () => {
  it('emits child-wait-lost only on true-to-false, then permits a later transition', async () => {
    let wait: boolean | 'unknown' = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round9-wait-'));
    const store = new Store(dir); await store.init();
    const cli = new Round9Cli(); cli.agents = { child: { id: 'child', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString(), Cwd: process.cwd() } };
    const service = new CompanionService(cli as any, store, undefined, { detect: async () => wait });
    await store.addManager('manager-1'); await store.trackChild('manager-1', 'child', 'explicit');
    await service.reconcileOnce();
    expect(store.getReminders().filter((r) => r.kind === 'child-watch' && r.status === 'active')).toHaveLength(0);
    expect(cli.prompts.some((body) => body.includes('child-wait-lost'))).toBe(false);
    wait = false; await service.reconcileOnce();
    expect(store.getReminders().filter((r) => r.kind === 'child-watch' && r.status === 'active' && !r.daemonId)).toHaveLength(1);
    await service.reconcileOnce();
    wait = true; await service.reconcileOnce();
    expect(store.getReminders().filter((r) => r.kind === 'child-watch' && r.status === 'active')).toHaveLength(0);
    wait = false; await service.reconcileOnce();
    const lost = cli.prompts.filter((body) => body.includes('event=child-wait-lost'));
    expect(lost).toHaveLength(2);
    expect(lost[0]).toContain('child=child');
    expect(lost[0]).toContain('wait disappeared');
    expect(lost[0]).toContain('300s polling fallback');
    expect(lost[0]).toContain('immediate→5 minutes');
    service.close();
  });

  it('keeps untracked children visible, reports read-only anomalies, and never arms a child-watch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round9-untracked-'));
    const store = new Store(dir); await store.init();
    const cli = new Round9Cli(); cli.agents = { child: { id: 'child', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: '2020-01-01T00:00:00.000Z', Cwd: process.cwd() } };
    const service = new CompanionService(cli as any, store, undefined, { detect: async () => false });
    await store.addManager('manager-1');
    const listed = await service.listChildren('manager-1');
    expect(listed.children[0]).toEqual(expect.objectContaining({ id: 'child', tracked: false, hasLivePaseoWait: false }));
    await service.reconcileOnce();
    expect(cli.prompts.some((body) => body.includes('event=child-no-wakeup') || body.includes('event=child-stale'))).toBe(true);
    expect(store.getReminders().filter((r) => r.kind === 'child-watch')).toHaveLength(0);
    const normal = await makeService(false);
    normal.cli.agents.child.Status = 'idle';
    normal.cli.agents.child.UpdatedAt = new Date().toISOString();
    await normal.service.reconcileOnce();
    expect(normal.cli.prompts).toHaveLength(0);
    service.close();
    normal.service.close();
  });

  it('includes the five current snapshot facts for anomalies and stays silent when normal', async () => {
    const { service, cli } = await makeService(false);
    await service.watchdogTick('manager-1', Date.now() + 4_000_000, 1);
    const alert = cli.prompts.find((body) => body.includes('event=child-stale'));
    expect(alert).toBeDefined();
    for (const field of ['child=child', 'status=running', 'updatedAt=', 'hasLivePaseoWait=false', 'gitDirty=', 'latestCommit=']) expect(alert).toContain(field);
    const normal = await makeService(false);
    normal.cli.agents.child.Status = 'idle';
    await normal.service.watchdogTick('manager-1');
    expect(normal.cli.prompts).toHaveLength(0);
    service.close();
    normal.service.close();
  });

  it('returns canonical wakeup aliases with an explicit incomplete boundary', async () => {
    const { service } = await makeService(false);
    const listed = await service.listChildren('manager-1');
    expect(listed.companionKnownWakeupSources).toEqual(listed.selfWakeupSources);
    expect(listed.wakeupSourcesComplete).toBe(false);
    expect(listed.wakeupSourcesNote).toContain('external heartbeats');
    service.close();
  });

  it('retires a legacy child-watch daemon without rebuilding it', async () => {
    const { service, store, cli } = await makeService(false);
    await store.addReminder({ id: 'legacy', daemonId: 'old-daemon', agentId: 'manager-1', subjectChildId: 'child', kind: 'child-watch', watchKind: 'child', name: 'legacy', prompt: 'old', cron: '* * * * *', expiresIn: '1h', status: 'active', alive: true, createdAt: new Date().toISOString() });
    await (service as any).ensureChildWatch('manager-1', 'child', false, process.cwd());
    expect(cli.calls.some((a) => a[0] === 'heartbeat' && a[1] === 'delete' && a[2] === 'old-daemon')).toBe(true);
    expect(cli.calls.some((a) => a[0] === 'heartbeat' && a[1] === 'create')).toBe(false);
    expect(store.getReminders().some((r) => r.id === 'legacy' && r.status === 'deleted')).toBe(true);
    expect(store.getReminders().some((r) => r.kind === 'child-watch' && !r.daemonId && r.status === 'active')).toBe(true);
    service.close();
  });

  it('does not arm or report child-wait-lost when wait observation is unknown', async () => {
    const { service, cli } = await makeService('unknown');
    await service.watchdogTick('manager-1');
    expect(cli.prompts.some((body) => body.includes('child-wait-lost'))).toBe(false);
    expect(cli.calls.some((a) => a[0] === 'heartbeat' && a[1] === 'create')).toBe(false);
    service.close();
  });

  it('serves self runtime identity from the live process and real store directory', async () => {
    const { service, store } = await makeService(false);
    const app = await createServer(service);
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address() as any;
    service.setPort(address.port);
    const response = await fetch(`http://127.0.0.1:${address.port}/self/runtime`);
    const runtime = await response.json() as any;
    expect(runtime).toEqual(expect.objectContaining({ pid: process.pid, cwd: process.cwd(), dataDir: store.dir, port: address.port }));
    service.close();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });
});
