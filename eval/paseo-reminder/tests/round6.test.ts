import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionService } from '../../../skills/paseo-companion/paseo-reminder/src/service.js';
import { Store } from '../../../skills/paseo-companion/paseo-reminder/src/store.js';

class FakeCli {
  agents: Record<string, any> = {};
  sends: string[] = [];
  heartbeatArgs: string[][] = [];
  async run(args: string[]): Promise<any> {
    if (args[0] === 'ls') return { value: Object.values(this.agents).map((agent) => ({ id: agent.id })) };
    if (args[0] === 'inspect') return { value: this.agents[args[1]] ?? { id: args[1], Status: 'idle', UpdatedAt: '2026-01-01T00:00:00.000Z' } };
    if (args[0] === 'send') { this.sends.push(args.at(-1) ?? ''); return { value: { status: 'sent', id: `send-${this.sends.length}` } }; }
    if (args[0] === 'schedule' && args[1] === 'ls') return { value: { schedules: [] } };
    if (args[0] === 'schedule' && args[1] === 'inspect') return { value: { id: args[2], status: 'active' } };
    if (args[0] === 'schedule' && args[1] === 'logs') return { value: [] };
    if (args[0] === 'heartbeat' && args[1] === 'create') { this.heartbeatArgs.push(args); return { value: { id: 'hb-1', status: 'active' } }; }
    return { value: {} };
  }
}
const detector = { detect: async () => false };

function heartbeatPrompts(cli: FakeCli): string[] {
  return cli.heartbeatArgs.filter((args) => args[0] === 'heartbeat' && args[1] === 'create').map((args) => String(args[2] ?? ''));
}

async function makeService(agent: any, options: any = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'companion-round6-'));
  const store = new Store(dir); await store.init();
  const cli = new FakeCli(); cli.agents = { [agent.id]: agent };
  const service = new CompanionService(cli as any, store, undefined, detector, options);
  await store.addManager('manager-1');
  if (agent.ParentAgentId) await store.trackChild('manager-1', agent.id, 'explicit');
  return { service, cli, store, dir };
}

describe('round6 watchdog', () => {
  it('watchdog child completion emits only on running to idle transition', async () => {
    const { service, cli } = await makeService({ id: 'child-1', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1');
    cli.agents['child-1'].Status = 'idle'; cli.agents['child-1'].UpdatedAt = new Date().toISOString();
    await service.watchdogTick('manager-1');
    const delivered = heartbeatPrompts(cli).find((body) => body.includes('event=child-completed'))!;
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=child-completed'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0);
    expect(delivered).toContain('<paseo-reminder-delivery to="manager-1" kind="watchdog">');
    expect(delivered).toContain('<note marker="NOT_USER_INPUT">');
    expect(delivered).toContain('child-1');
  });
  it('watchdog child without a live wakeup emits a health alert', async () => {
    const { service, cli } = await makeService({ id: 'child-2', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1');
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=child-no-wakeup'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0);
  });
  it('watchdog stale child emits when updatedAt exceeds configured threshold', async () => {
    const { service, cli } = await makeService({ id: 'child-3', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: '2020-01-01T00:00:00.000Z' }, { watchdogStaleMs: 1 });
    await service.watchdogTick('manager-1');
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=child-stale'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0);
  });
  it('watchdog manager bare-runner emits when no self source or live wait exists', async () => {
    const { service, cli } = await makeService({ id: 'child-4', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1');
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=manager-bare'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0);
  });
  it('treats a live paseo wait on a running child as manager coverage', async () => {
    const { service, cli } = await makeService({ id: 'child-covered', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1', Date.now(), undefined, {
      children: [{ id: 'child-covered', status: 'running', tracked: true, hasLivePaseoWait: true, hasLiveCompanionWatch: false, hasLiveWakeupSource: true, parked: false, gitDirty: false }],
      companionKnownWakeupSources: [], selfWakeupSources: [], wakeupSourcesComplete: false,
      wakeupSourcesNote: 'test', partial: false, failedCandidates: [],
    }, false);
    expect(cli.sends.some((body) => body.includes('event=manager-bare'))).toBe(false);
  });
  it('watchdog tracked-child-empty is silent', async () => {
    const { service, cli } = await makeService({ id: 'manager-1', Status: 'idle', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1'); expect(cli.sends).toHaveLength(0);
  });
  it('watchdog deduplicates a sustained condition across three ticks', async () => {
    const { service, cli } = await makeService({ id: 'child-5', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1'); await service.watchdogTick('manager-1'); await service.watchdogTick('manager-1');
    const prompts = heartbeatPrompts(cli);
    expect(prompts).toHaveLength(2);
    expect(prompts.filter((body) => body.includes('event=child-no-wakeup'))).toHaveLength(1);
    expect(prompts.filter((body) => body.includes('event=manager-bare'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0);
  });
  it('watchdog cancellation persists, suppresses future ticks, and distinguishes unknown IDs', async () => {
    const { service, cli, store } = await makeService({ id: 'child-cancel', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1');
    const alert = store.getReminders().find((item) => item.kind === 'watchdog' && item.eventType === 'child-no-wakeup')!;
    const initialHeartbeats = heartbeatPrompts(cli);
    const alertPrompt = initialHeartbeats.find((body) => body.includes('event=child-no-wakeup'))!;
    expect(initialHeartbeats).toHaveLength(2);
    expect(initialHeartbeats.filter((body) => body.includes('event=child-no-wakeup'))).toHaveLength(1);
    expect(alertPrompt).toContain(`id=${alert.id}`); expect(alertPrompt).toContain(`/reminders/${alert.id}`); expect(alertPrompt).not.toContain('<port>');
    expect(cli.sends).toHaveLength(0);
    await service.deleteReminder(alert.id, 'not needed');
    await service.watchdogTick('manager-1'); await service.watchdogTick('manager-1');
    expect(heartbeatPrompts(cli).filter((body) => body.includes(`id=${alert.id}`))).toHaveLength(1);
    expect(heartbeatPrompts(cli)).toHaveLength(initialHeartbeats.length);
    expect(cli.sends).toHaveLength(0);
    await expect(service.deleteReminder('unknown-alert', 'not needed')).rejects.toThrow('reminder not found');
    await expect(service.deleteReminder(alert.id, 'already cancelled')).resolves.toEqual(expect.objectContaining({ status: 'deleted' }));
  });
  it('watchdog restart does not replay a previously notified event', async () => {
    const { service, cli, dir } = await makeService({ id: 'child-6', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    await service.watchdogTick('manager-1');
    expect(heartbeatPrompts(cli)).toHaveLength(2);
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=child-no-wakeup'))).toHaveLength(1);
    expect(heartbeatPrompts(cli).filter((body) => body.includes('event=manager-bare'))).toHaveLength(1);
    expect(cli.sends).toHaveLength(0); service.close();
    const store = new Store(dir); await store.init(); const restartedCli = new FakeCli(); restartedCli.agents = cli.agents;
    const restarted = new CompanionService(restartedCli as any, store, undefined, detector); await restarted.watchdogTick('manager-1');
    expect(heartbeatPrompts(restartedCli)).toHaveLength(0);
    expect(restartedCli.sends).toHaveLength(0);
  });
});

describe('round6 reminders', () => {
  it('stores exact one-shot deadlines and requires an explicit repeat interval', async () => {
    const first = await makeService({ id: 'manager-1', Status: 'idle', UpdatedAt: new Date().toISOString() });
    const oneShot = await first.service.createReminder({ agentId: 'manager-1', delaySeconds: 60, message: 'once', maxRuns: 1 });
    const repeat = await first.service.createReminder({ agentId: 'manager-1', mode: 'repeat', everySeconds: 60, message: 'repeat' });
    expect(first.cli.heartbeatArgs).toHaveLength(0);
    expect(oneShot.mode).toBe('once'); expect(Date.parse(oneShot.targetAt!)).toBeGreaterThan(Date.now());
    expect(repeat.mode).toBe('repeat'); expect(repeat.everySeconds).toBe(60);
    expect(oneShot.prompt).toContain(`id=${oneShot.id}`); expect(oneShot.prompt).toContain(`/reminders/${oneShot.id}`); expect(oneShot.prompt).not.toContain('<port>');
  });
  it('lists reminder state and stamps the actual firing time into the delivered prompt', async () => {
    const { service, store, cli } = await makeService({ id: 'manager-1', Status: 'idle', UpdatedAt: new Date().toISOString() });
    const reminder = await service.createReminder({ agentId: 'manager-1', mode: 'once', delaySeconds: 60, message: 'fire once', delivery: 'interrupt' });
    expect(service.listReminders('manager-1').map((item) => item.id)).toContain(reminder.id);
    expect(service.getReminder(reminder.id).prompt).toContain('triggeredAt=pending');
    await store.updateReminder(reminder.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    await service.reconcileReminders();
    const fired = service.getReminder(reminder.id);
    expect(fired.lastFiredAt).toBeTruthy();
    expect(fired.prompt).toContain(`triggeredAt=${fired.lastFiredAt}`);
    expect(fired.prompt).not.toContain('triggeredAt=pending');
    expect(cli.sends.at(-1)).toContain('<paseo-reminder-delivery to="manager-1" kind="reminder">');
    expect(cli.sends.at(-1)).toContain('<note marker="NOT_USER_INPUT">');
    expect(cli.sends.at(-1)).toContain(`triggeredAt=${fired.lastFiredAt}`);
    expect(cli.sends.at(-1)).toContain(`<ack>curl -X DELETE http://127.0.0.1:8787/reminders/${reminder.id}`);
  });
  it('child-watch, compact-wake, and heartbeat-recovery each generate structured IDs and real cancellation commands', async () => {
    const childCase = await makeService({ id: 'child-message', ParentAgentId: 'manager-1', Status: 'running', UpdatedAt: new Date().toISOString() });
    const childWatch = await childCase.service.createReminder({ agentId: 'manager-1', subjectChildId: 'child-message', kind: 'child-watch', watchKind: 'child', delaySeconds: 60, message: 'watch child' });
    expect(childWatch.prompt).toContain(`id=${childWatch.id}`); expect(childWatch.prompt).toContain(`/reminders/${childWatch.id}`); expect(childWatch.prompt).not.toContain('<port>');
    const compact = await childCase.service.compactWake({ agentId: 'manager-1', compact: 'summarize progress', wake: 'resume' });
    const compactRecord = childCase.store.getReminders().find((item) => item.kind === 'compact-wake')!;
    expect(compactRecord.prompt).toContain('<paseo-reminder-delivery to="manager-1" kind="compact-wake">'); expect(compactRecord.prompt).toContain(`id=${compactRecord.id}`); expect(compactRecord.prompt).toContain(`/reminders/${compactRecord.id}`); expect(compactRecord.prompt).not.toContain('<port>');
    await childCase.store.addReminder({ id: 'source-recovery', daemonId: 'hb-source', agentId: 'manager-1', name: 'source-recovery', prompt: 'source', cron: '*/5 * * * *', expiresIn: '1h', status: 'active', alive: true, missedFires: 1, missedRunIds: ['run-1'], createdAt: new Date().toISOString() });
    await childCase.service.reconcileReminders();
    expect(childCase.cli.sends.some((body) => body.includes('<paseo-reminder-delivery to="manager-1" kind="watchdog">') && body.includes('type=heartbeat-recovery') && body.includes('event=missed-heartbeat') && body.includes('/reminders/companion-recovery-'))).toBe(true);
  });
  it('cancelling one-shot, idle, compact-wake, and recovery reminders suppresses later automatic delivery', async () => {
    const one = await makeService({ id: 'manager-1', Status: 'idle', UpdatedAt: new Date().toISOString() });
    const oneShot = await one.service.createReminder({ agentId: 'manager-1', delaySeconds: 60, message: 'cancel me', maxRuns: 1 });
    await one.service.deleteReminder(oneShot.id, 'cancelled'); await one.service.reconcileReminders();
    expect(one.store.findReminder(oneShot.id)?.status).toBe('deleted'); expect(one.cli.sends).toHaveLength(0);

    const idle = await one.service.createIdleReminder({ agentId: 'manager-1', thresholdSeconds: 1, message: 'idle cancel' });
    await one.service.deleteIdleReminder(idle.id, 'cancelled');
    await one.store.updateIdleReminder(idle.id, { idleSince: new Date(Date.now() - 5000).toISOString(), lastObservedUpdatedAt: one.cli.agents['manager-1']?.UpdatedAt });
    await one.service.listIdleReminders(); expect(one.cli.sends).toHaveLength(0);

    await one.service.compactWake({ agentId: 'manager-1', compact: 'summarize progress', wake: 'resume' });
    const compact = one.store.getReminders().find((item) => item.kind === 'compact-wake')!;
    await one.service.deleteReminder(compact.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(one.store.findReminder(compact.id)?.status).toBe('deleted'); expect(one.cli.sends).toHaveLength(0);

    await one.store.addReminder({ id: 'recovery-source', daemonId: 'hb-source', agentId: 'manager-1', name: 'recovery-source', prompt: 'source', cron: '* * * * *', expiresIn: '1h', status: 'active', alive: true, missedFires: 1, missedRunIds: ['run-1'], createdAt: new Date().toISOString() });
    await one.service.reconcileReminders();
    const recovery = one.store.getReminders().find((item) => item.kind === 'heartbeat-recovery')!;
    const sendsAfterRecovery = one.cli.sends.length;
    await one.service.deleteReminder(recovery.id, 'cancelled');
    await one.store.updateReminder('recovery-source', { missedFires: 1, missedRunIds: ['run-2'], alive: true });
    await one.service.reconcileReminders();
    expect(one.store.findReminder(recovery.id)?.status).toBe('deleted'); expect(one.cli.sends).toHaveLength(sendsAfterRecovery);
  });
  it('idle reminder stays silent while manager remains busy', async () => {
    const { service, cli } = await makeService({ id: 'manager-1', Status: 'running', UpdatedAt: '2026-01-01T00:00:00.000Z' });
    await service.createIdleReminder({ agentId: 'manager-1', thresholdSeconds: 0.001, message: 'idle nudge' });
    await service.listIdleReminders(); await service.listIdleReminders();
    expect(cli.sends).toHaveLength(0);
  });
  it('idle reminder triggers, resets its accumulator, and can trigger again', async () => {
    const { service, cli, store } = await makeService({ id: 'manager-1', Status: 'idle', UpdatedAt: '2026-01-01T00:00:00.000Z' });
    const reminder = await service.createIdleReminder({ agentId: 'manager-1', thresholdSeconds: 1, message: 'idle nudge' });
    await store.updateIdleReminder(reminder.id, { idleSince: new Date(Date.now() - 5_000).toISOString(), lastObservedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await service.listIdleReminders(); expect(cli.sends).toHaveLength(1); expect(cli.sends[0]).toContain('<paseo-reminder-delivery to="manager-1" kind="reminder">'); expect(cli.sends[0]).toContain(`id=${reminder.id}`); expect(cli.sends[0]).toContain(`/idle-reminders/${reminder.id}`); expect(cli.sends[0]).not.toContain('<port>'); expect(store.findIdleReminder(reminder.id)?.idleSince).toBeUndefined();
    await store.updateIdleReminder(reminder.id, { idleSince: new Date(Date.now() - 5_000).toISOString() });
    await service.listIdleReminders(); expect(cli.sends).toHaveLength(2);
  });
});
