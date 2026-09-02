import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

class FakeCli {
  sends = 0;
  launches: string[][] = [];
  status = 'idle';
  failInspect = false;
  failLaunch = false;
  launchReceipt: Record<string, unknown> = { id: 'worker-live' };
  onInspect?: () => Promise<void>;
  onStartTurn?: () => Promise<void>;
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') { if (this.failInspect) throw new Error('paseo inspect is unavailable'); await this.onInspect?.(); return { value: { id: 'worker-live', status: this.status, provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' }; }
    if (args[0] === 'run') { this.launches.push(args); if (this.failLaunch) throw new Error('paseo run failed to reach the daemon'); return { value: this.launchReceipt, stdout: '', stderr: '' }; }
    if (args[0] === 'start-turn') { this.sends += 1; await this.onStartTurn?.(); return { value: {}, stdout: '', stderr: '' }; }
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

  it('B0-1 refuses a contract when the runtime\'s delivery state is merely indeterminate or in flight', async () => {
    for (const state of ['attempting', 'transport_indeterminate'] as const) {
      const { service, cli, actor, task } = await fixture();
      await service.store.mutate((value: any) => value.deliveries.push({ id: `delivery-prior-${state}`, fromActorId: actor.id, runtimeSessionId: 'worker-runtime', generation: 1, body: 'earlier turn', command: 'normal', state, createdAt: new Date().toISOString() }));
      const before = cli.sends;
      const refused: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
      expect(refused.state).toBe('withdrawn');
      expect(refused.refusedReason).toContain('indeterminate');
      expect(cli.sends).toBe(before);
      service.close();
    }
  });

  it('B0-2 revalidates the contract adjacent to startTurn, not only before the observe await', async () => {
    const { service, cli, actor, task, worker } = await fixture();
    cli.status = 'running';
    const queued: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
    expect(queued.state).toBe('waiting_safe_point');
    const before = cli.sends;
    // The claim lands inside the pump's own observe() await, after the first
    // contractRefusal has already passed.
    cli.status = 'idle';
    cli.onInspect = async () => { cli.onInspect = undefined; await service.store.mutate((state: any) => { const value = state.tasks.find((item: any) => item.id === task.id); value.ownerMemberId = worker.member.id; value.fence = 1; value.lifecycle = 'claimed'; }); };
    await (service as any).pump();
    const settled = service.state().deliveries.find((item) => item.id === queued.id)!;
    expect(settled.state).toBe('withdrawn');
    expect(settled.refusedReason).toContain('no longer matches task fence');
    expect(cli.sends).toBe(before);
    expect(service.state().channelEvents.some((item) => item.content.summary.includes('Late Goal Contract') && item.taskId === task.id)).toBe(true);
    service.close();
  });

  it('B0-3 keeps a withdrawal truthful when startTurn had already handed the contract over', async () => {
    const { service, cli, actor, task } = await fixture();
    cli.status = 'running';
    const queued: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: 'worker-runtime', ...contract({ taskId: task.id, fence: 0 }) });
    expect(queued.state).toBe('waiting_safe_point');
    // submitResult's withdrawal lands while the turn is already in flight; it
    // cannot cancel that turn, so the runtime really does receive the body.
    cli.onStartTurn = async () => { await service.store.mutate((state: any) => { const item = state.deliveries.find((value: any) => value.id === queued.id); item.state = 'withdrawn'; item.refusedReason = 'task already has a submitted Result'; }); };
    cli.status = 'idle';
    await (service as any).pump();
    const settled = service.state().deliveries.find((item) => item.id === queued.id)!;
    expect(settled.state).toBe('withdrawn');
    expect(settled.handedOffAfterWithdrawal).toBe(true);
    expect(service.state().channelEvents.some((item) => item.content.summary.includes('had already been handed to runtime worker-runtime'))).toBe(true);
    service.close();
  });

  it('B0-4 recovers an inherited attempting contract as transport-indeterminate after restart', async () => {
    const { root, service, actor, task } = await fixture();
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'delivery-crashed-attempt', fromActorId: actor.id, runtimeSessionId: 'worker-runtime', generation: 1, body: 'contract', command: 'normal', purpose: 'contract', subject: { taskId: task.id, fence: 0 }, state: 'attempting', createdAt: new Date().toISOString() }));
    service.close();
    const restarted = new ArcpService(root, new FakeCli() as any);
    await restarted.init();
    expect(restarted.state().deliveries.find((item) => item.id === 'delivery-crashed-attempt')?.state).toBe('transport_indeterminate');
    expect(restarted.state().channelEvents.some((item) => item.kind === 'transport_uncertainty' && item.content.summary.includes('delivery-crashed-attempt'))).toBe(true);
    restarted.close();
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
  /** Assert the whole launch attempt was retired: credential destroyed, member
   * retired, client-state file gone, and no orphan active Goal or open Task. */
  async function expectNoOrphan(service: any, root: string, title: string) {
    const state = service.state();
    const managed = state.members.filter((item: any) => item.label.startsWith('managed-'));
    expect(managed).toHaveLength(1);
    expect(managed[0].lifecycle).toBe('retired');
    expect(Object.values(state.memberCredentials)).not.toContain(managed[0].id);
    expect(state.goals.filter((item: any) => item.title === title).map((item: any) => item.state)).toEqual(['cancelled']);
    expect(state.tasks.filter((item: any) => item.title === title).map((item: any) => item.lifecycle)).toEqual(['cancelled']);
    const files = await readdir(path.join(root, 'runtime-members')).catch(() => [] as string[]);
    expect(files).toHaveLength(0);
  }

  it('F3 leaves no orphan credential, Goal or Task when a real adapter launch fails', async () => {
    const { service, cli, actor, workspace, root } = await fixture();
    let preflights = 0;
    const preflight = service.preflight.bind(service);
    (service as any).preflight = (input: any) => { preflights += 1; return preflight(input); };
    // A real adapter failure, not a synthetic throw wrapped around a launch
    // that actually happened: `paseo run` itself fails.
    cli.failLaunch = true;
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'orphan goal', profileId: 'codex-worker', workspace: '/tmp' } as any)).rejects.toMatchObject({ code: 'launch_failed' });
    expect(preflights).toBe(1);
    expect(cli.launches).toHaveLength(1);
    await expectNoOrphan(service, root, 'orphan goal');
    service.close();
  });

  it('F3 refuses a launch that returns a session with no adapter receipt', async () => {
    const { service, actor, workspace, root } = await fixture();
    // launch() keeps this session in transport_indeterminate rather than
    // throwing, which is exactly the failure the orphan guard used to miss.
    (service as any).adapter.cli.launchReceipt = {};
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'receiptless goal', profileId: 'codex-worker', workspace: '/tmp' } as any)).rejects.toMatchObject({ code: 'launch_failed' });
    expect((await service.launch({ actorId: actor.id, goalId: (await service.createGoal({ actorId: actor.id, title: 'direct' })).id, profileId: 'codex-worker' })).state).toBe('transport_indeterminate');
    await expectNoOrphan(service, root, 'receiptless goal');
    service.close();
  });

  it('F3 leaves no orphan credential when the client-state file cannot be written', async () => {
    const { service, actor, workspace, root } = await fixture();
    (service as any).prepareRuntimeClientState = async () => { throw new Error('runtime-members is not writable'); };
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'unwritable goal', profileId: 'codex-worker', workspace: '/tmp' } as any)).rejects.toThrow('not writable');
    await expectNoOrphan(service, root, 'unwritable goal');
    service.close();
  });
});

describe('ARCP launched-runtime authority', () => {
  it('P0-1 gives every launchable task-owning role the capabilities its handoff demands', async () => {
    const { service, cli, actor, workspace } = await fixture();
    const reviewer: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'review round', role: 'reviewer', profileId: 'codex-worker', workspace: '/tmp' } as any);
    expect(reviewer.member.capabilities).toEqual(expect.arrayContaining(['claim_task', 'submit_result']));
    // A fresh Reviewer can claim its own Task and submit its own verdict.
    await service.claimTask(reviewer.task.id, reviewer.member.id, 0);
    const verdict = await service.submitResult({ workspaceId: workspace.id, taskId: reviewer.task.id, memberId: reviewer.member.id, status: 'candidate', summary: 'REWORK', evidenceRefs: ['commit:abc'], expectedFence: 1 });
    expect(verdict.memberId).toBe(reviewer.member.id);
    expect(cli.launches.at(-1)!.at(-1)).toContain('ARCP Worker handoff');
    service.close();
  });

  it('P0-1 never instructs an observer role to claim a Task it cannot claim', async () => {
    const { service, cli, actor, workspace } = await fixture();
    const steward: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'observer round', role: 'steward', profileId: 'codex-worker', workspace: '/tmp' } as any);
    expect(steward.member.capabilities).not.toContain('claim_task');
    const prompt = cli.launches.at(-1)!.at(-1)!;
    expect(prompt).not.toContain('ARCP Worker handoff');
    expect(prompt).toContain('joins as an observer');
    service.close();
  });

  it('binds the acting credential to the acting runtime and records a borrowed-credential attempt', async () => {
    const { service, actor, workspace } = await fixture();
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'bound work', profileId: 'codex-worker', workspace: '/tmp' } as any);
    const borrower = await service.joinWorkspace({ workspaceId: workspace.id, label: 'borrower', role: 'manager' });
    await expect(service.claimTask(started.task.id, borrower.member.id, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.state().channelEvents.some((item) => item.content.summary.includes('Borrowed-credential claim refused') && item.taskId === started.task.id)).toBe(true);
    // Even if an out-of-band corruption makes the borrower look like the Task
    // holder, a valid credential issued to a different managed runtime cannot
    // settle this runtime's Task.
    await service.store.mutate((state: any) => { const value = state.tasks.find((item: any) => item.id === started.task.id); value.ownerMemberId = borrower.member.id; value.fence = 1; value.lifecycle = 'claimed'; });
    await expect(service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: borrower.member.id, status: 'candidate', summary: 'borrowed', evidenceRefs: ['commit:abc'], expectedFence: 1 })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.state().channelEvents.some((item) => item.content.summary.includes('Borrowed-credential result refused') && item.taskId === started.task.id)).toBe(true);
    expect(service.state().results.some((item) => item.taskId === started.task.id)).toBe(false);
    service.close();
  });

  it('P0-3 lets the accountable member discharge a role-targeted event that was never runtime-delivered', async () => {
    const { service, actor, workspace } = await fixture();
    const manager = await service.joinWorkspace({ workspaceId: workspace.id, label: 'manager', role: 'manager' });
    const stranger = await service.joinWorkspace({ workspaceId: workspace.id, label: 'stranger', role: 'reviewer' });
    // No managed manager runtime exists, so the pump never mints a Delivery and
    // deliveryState stays queued forever.
    const event = await service.publishChannelEvent({ workspaceId: workspace.id, sourceActorId: actor.id, targetRole: 'manager', kind: 'blocker', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'undeliverable obligation', evidenceRefs: [], notify: false } as any);
    expect(event.deliveryState).toBe('queued');
    expect(service.state().deliveries.filter((item) => item.eventId === event.id)).toHaveLength(0);
    // Authorization is unchanged: a member who is not the accountable target is
    // still refused.
    await expect(service.acknowledgeEvent(event.id, stranger.member.id, 'not mine')).rejects.toMatchObject({ code: 'unauthorized' });
    const acknowledged = await service.acknowledgeEvent(event.id, manager.member.id, 'read directly from the channel');
    expect(acknowledged.consumptionState).toBe('consumed');
    // The record stays truthful about never having been transported.
    expect(acknowledged.transitions.map((item) => item.state)).toEqual(['queued', 'acknowledged']);
    service.close();
  });

  it('P0-3 still refuses an acknowledgement while a Delivery for the event is in flight', async () => {
    const { service, cli, actor, workspace, worker } = await fixture();
    cli.status = 'running';
    const event = await service.publishChannelEvent({ workspaceId: workspace.id, goalId: service.state().goals[0].id, sourceActorId: actor.id, targetActorId: actor.id, kind: 'attention', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'in flight obligation', evidenceRefs: [], notify: false } as any);
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'delivery-in-flight', fromActorId: actor.id, runtimeSessionId: 'worker-runtime', generation: 1, body: 'obligation', command: 'normal', eventId: event.id, state: 'waiting_safe_point', createdAt: new Date().toISOString() }));
    await expect(service.acknowledgeEvent(event.id, worker.member.id, 'too early')).rejects.toMatchObject({ code: 'invalid_request' });
    service.close();
  });

  it('routes a completed Result to its accountable primary handler with observe-only cc', async () => {
    const { service, actor, workspace } = await fixture();
    const deputy = await service.joinWorkspace({ workspaceId: workspace.id, label: 'deputy', role: 'owner' });
    const manager = await service.joinWorkspace({ workspaceId: workspace.id, label: 'manager', role: 'manager' });
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'reviewed round', role: 'reviewer', profileId: 'codex-worker', workspace: '/tmp', launchedByMemberId: deputy.member.id, primaryHandlerMemberId: manager.member.id } as any);
    expect(started.session.reportingRoute).toMatchObject({ launchedByMemberId: deputy.member.id, primaryHandlerMemberId: manager.member.id, ccMemberIds: [deputy.member.id] });
    await service.claimTask(started.task.id, started.member.id, 0);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'verdict', evidenceRefs: ['commit:abc'], expectedFence: 1 });
    const decision = service.state().channelEvents.find((item) => item.kind === 'decision_required' && item.resultId === result.id)!;
    expect(decision.targetMemberId).toBe(manager.member.id);
    expect(decision.targetRole).toBeUndefined();
    const cc = service.state().channelEvents.find((item) => item.targetMemberId === deputy.member.id && item.relatedEventId === decision.id)!;
    expect(cc.decisionRequired).toBe(false);
    expect(cc.consumptionPolicy).toBe('consume_on_delivery');
    service.close();
  });
});
