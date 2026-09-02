import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

class FakeCli {
  sends = 0;
  launches: string[][] = [];
  status = 'idle';
  failInspect = false;
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') { if (this.failInspect) throw new Error('paseo inspect is unavailable'); return { value: { id: 'worker-live', status: this.status, provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' }; }
    if (args[0] === 'run') { this.launches.push(args); return { value: { id: 'worker-live' }, stdout: '', stderr: '' }; }
    if (args[0] === 'start-turn') { this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    return { value: [], stdout: '', stderr: '' };
  }
}

/** One managed Worker runtime bound to one ready Task, with a Manager actor
 * able to send it deliveries. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-contract-binding-'));
  const cli = new FakeCli();
  const service = new ArcpService(root, cli as any);
  await service.init();
  const { actor, binding } = await service.registerActor({ clientIdentity: 'contract-owner' });
  const workspace = (await service.createWorkspace({ ownerActorId: actor.id, purpose: 'contract binding' })).workspace;
  const worker = await service.joinWorkspace({ workspaceId: workspace.id, label: 'Worker', role: 'worker', joinKind: 'managed', actorId: actor.id });
  const goal = await service.createGoal({ actorId: actor.id, title: 'contract goal', workspaceId: workspace.id });
  const task = await service.createTask({ workspaceId: workspace.id, title: 'contract goal' });
  await service.store.mutate((state: any) => state.sessions.push({ id: 'worker-runtime', actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.id, memberId: worker.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'worker-live', createdAt: new Date().toISOString() }));
  return { root, service, cli, actor, workspace, worker, task };
}

const contract = (subject: { taskId: string; fence: number }, notAfter?: string) => ({ purpose: 'contract' as const, subject, ...(notAfter ? { notAfter } : {}), body: 'Goal Contract: own exactly src/arcp.ts' });

describe('ARCP atomic contract binding', () => {
  it('B0 binds the Goal Contract into the first UserMessage of the launch itself', async () => {
    const { service, cli, actor, workspace } = await fixture();
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'bound goal', contract: 'OWN EXACTLY src/arcp.ts; claim at fence 0', profileId: 'codex-worker', workspace: '/tmp' } as any);
    expect('session' in started).toBe(true);
    const prompt = cli.launches.at(-1)!.at(-1)!;
    expect(prompt).toContain('ARCP Goal Contract');
    expect(prompt).toContain('OWN EXACTLY src/arcp.ts; claim at fence 0');
    // The contract is in the launch, so no follow-up turn is needed to deliver it.
    expect(cli.sends).toBe(0);
    service.close();
  });

  it('T1 refuses a late contract after the runtime has started work, without starting a turn', async () => {
    const { service, cli, actor, task, worker } = await fixture();
    await service.claimTask(task.id, worker.member.id, 0);
    const before = cli.sends;
    const refused: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
    expect(refused.state).toBe('withdrawn');
    expect(refused.refusedReason).toContain('no longer matches task fence');
    // Refused at deliver() time: it was never queued for a safe point at all.
    expect(refused.eventId).toBeUndefined();
    // Even at the current fence the contract is late: the runtime already claimed.
    const late: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 1 }) });
    expect(late.state).toBe('withdrawn');
    expect(late.refusedReason).toContain('the runtime has acted without this contract');
    expect(late.eventId).toBeUndefined();
    expect(cli.sends).toBe(before);
    // The refusal is visibly recorded rather than silently dropped.
    expect(service.state().channelEvents.some((item) => item.content.summary.includes('Late Goal Contract') && item.taskId === task.id)).toBe(true);
    service.close();
  });

  it('T2 withdraws a pending contract whose subject no longer matches the current fence, without starting a turn', async () => {
    const { service, cli, actor, task, worker } = await fixture();
    cli.status = 'running';
    const queued: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
    expect(queued.state).toBe('waiting_safe_point');
    const before = cli.sends;
    await service.claimTask(task.id, worker.member.id, 0);
    cli.status = 'idle';
    await (service as any).pump();
    const settled = service.state().deliveries.find((item) => item.id === queued.id)!;
    expect(settled.state).toBe('withdrawn');
    expect(settled.refusedReason).toContain('no longer matches task fence');
    expect(cli.sends).toBe(before);
    service.close();
  });

  it('T3 withdraws a pending same-subject contract when the Result is submitted, and refuses a later one', async () => {
    const { service, cli, actor, task, worker } = await fixture();
    cli.status = 'running';
    const queued: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
    expect(queued.state).toBe('waiting_safe_point');
    await service.claimTask(task.id, worker.member.id, 0);
    // A contract parked outside the pump's safe-point path — the Goal C shape,
    // where a delayed delivery reawakens an already-stopped Worker — is only
    // withdrawn by submitResult itself, never by the pump.
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'delivery-parked-contract', fromActorId: actor.id, runtimeSessionId: 'worker-runtime', generation: 1, body: 'stale contract', command: 'normal', purpose: 'contract', subject: { taskId: task.id, fence: 1 }, state: 'held', createdAt: new Date().toISOString() }));
    await service.submitResult({ workspaceId: task.workspaceId, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'done', evidenceRefs: ['commit:abc'], expectedFence: 1 });
    expect(service.state().deliveries.find((item) => item.id === 'delivery-parked-contract')!.state).toBe('withdrawn');
    expect(service.state().deliveries.find((item) => item.id === queued.id)!.state).toBe('withdrawn');
    const before = cli.sends;
    cli.status = 'idle';
    await (service as any).pump();
    const reawakened: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 1 }) });
    expect(reawakened.state).toBe('withdrawn');
    expect(reawakened.refusedReason).toContain('already has a submitted Result');
    expect(cli.sends).toBe(before);
    service.close();
  });

  it('B0 refuses a contract whose notAfter has already passed', async () => {
    const { service, cli, actor, task } = await fixture();
    const before = cli.sends;
    const expired: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }, new Date(Date.now() - 1000).toISOString()) });
    expect(expired.state).toBe('withdrawn');
    expect(expired.refusedReason).toContain('contract expired at');
    expect(cli.sends).toBe(before);
    service.close();
  });
});

describe('ARCP runtime observation does not corrupt durable state', () => {
  it('F1 keeps a settled terminal lifecycle when a status read fails, and stays fail-closed for a live runtime', async () => {
    const { service, cli } = await fixture();
    await service.store.mutate((state: any) => { state.sessions[0].state = 'terminal'; state.runtimeBindings.push({ id: 'binding-1', executionSurfaceId: 'surface-1', runtimeSessionId: 'worker-runtime', nativeId: 'worker-live', writer: true, state: 'terminal', createdAt: new Date().toISOString() }); });
    cli.failInspect = true;
    await service.runtimeStatus('worker-runtime');
    expect(service.state().sessions[0].state).toBe('terminal');
    expect(service.state().runtimeBindings[0].state).toBe('terminal');
    await service.store.mutate((state: any) => { state.sessions[0].state = 'idle'; });
    await service.runtimeStatus('worker-runtime');
    expect(service.state().sessions[0].state).toBe('transport_indeterminate');
    expect(service.state().runtimeBindings[0].state).toBe('transport_indeterminate');
    service.close();
  });

  it('F2 performs no durable write on a read path once the canonical identity agrees', async () => {
    const { service } = await fixture();
    await service.runtimeStatus('worker-runtime');
    let writes = 0;
    const mutate = service.store.mutate.bind(service.store);
    (service.store as any).mutate = (fn: any) => { writes += 1; return mutate(fn); };
    await (service as any).canonicalRuntimeIdentity(service.state().sessions[0]);
    expect(writes).toBe(0);
    // A disagreeing binding is still repaired.
    await mutate((state: any) => { state.runtimeBindings.push({ id: 'binding-1', executionSurfaceId: 'surface-1', runtimeSessionId: 'worker-runtime', nativeId: '', writer: true, state: 'idle', createdAt: new Date().toISOString() }); });
    writes = 0;
    await (service as any).canonicalRuntimeIdentity(service.state().sessions[0]);
    expect(writes).toBe(1);
    expect(service.state().runtimeBindings[0].nativeId).toBe('worker-live');
    service.close();
  });
});

describe('ARCP managed launch credential lifecycle', () => {
  it('F3 runs one preflight and leaves no orphan credential when the launch never happens', async () => {
    const { service, cli, actor, workspace } = await fixture();
    let preflights = 0;
    const preflight = service.preflight.bind(service);
    (service as any).preflight = (input: any) => { preflights += 1; return preflight(input); };
    // A second runtime on a goal that already holds one is refused inside launch,
    // after the managed credential has been issued.
    const conflict = service.launch.bind(service);
    (service as any).launch = async (input: any) => { await conflict({ ...input }); throw new Error('placement failed after the credential was issued'); };
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'orphan goal', profileId: 'codex-worker', workspace: '/tmp' } as any)).rejects.toThrow('placement failed');
    expect(preflights).toBe(1);
    const managed = service.state().members.filter((item) => item.label.startsWith('managed-'));
    expect(managed).toHaveLength(1);
    expect(managed[0].lifecycle).toBe('retired');
    expect(service.state().memberCredentials[managed[0].id]).toBeUndefined();
    expect(cli.launches).toHaveLength(1);
    service.close();
  });
});
