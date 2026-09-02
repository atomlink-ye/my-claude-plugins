import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

class FakeCli {
  sends = 0;
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'manager-live', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    if (args[0] === 'start-turn') { this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    return { value: [], stdout: '', stderr: '' };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-consumption-')); const cli = new FakeCli(); const service = new ArcpService(root, cli as any); await service.init();
  const { actor, binding } = await service.registerActor({ clientIdentity: 'channel-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'channel consumption' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'Manager', role: 'manager' }); const goal = await service.createGoal({ actorId: actor.id, title: 'channel goal', workspaceId: workspace.workspace.id });
  await service.store.mutate((state: any) => state.sessions.push({ id: 'manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'manager-live', createdAt: new Date().toISOString() }));
  return { root, service, cli, workspace, manager };
}

describe('ARCP channel consumption MVE', () => {
  it('keeps priority orthogonal while informational delivery consumes once and never creates another wake', async () => {
    const { service, cli, workspace, manager } = await fixture();
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'phase_progress', urgency: 'normal', priority: 'critical', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: 'progress', evidenceRefs: [] });
    expect(service.state().channelEvents.find((item) => item.id === event.id)).toMatchObject({ priority: 'critical', consumptionPolicy: 'consume_on_delivery', consumptionState: 'consumed' });
    expect(cli.sends).toBe(1); await (service as any).pump(); expect(cli.sends).toBe(1);
    expect(service.channelEvents(workspace.workspace.id).find((item) => item.id === event.id)?.markdown).toContain('No reply required'); service.close();
  });

  it('requires an accountable reason for ACK, while a decision remains open after ACK and resolves durably', async () => {
    const { service, workspace, manager } = await fixture();
    const ack = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'correction', evidenceRefs: [] });
    await expect(service.acknowledgeEvent(ack.id, manager.member.id, '')).rejects.toMatchObject({ code: 'invalid_request' }); await service.acknowledgeEvent(ack.id, manager.member.id, 'updated the plan');
    expect(service.state().channelEvents.find((item) => item.id === ack.id)?.consumptionState).toBe('consumed');
    const decision = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'decision_required', urgency: 'normal', consumptionPolicy: 'decision_required', decisionRequired: true, summary: 'accept candidate?', evidenceRefs: [] });
    await expect(service.acknowledgeEvent(decision.id, manager.member.id, 'seen')).rejects.toMatchObject({ code: 'invalid_request' }); await service.resolveDecision(decision.id, manager.member.id, 'candidate accepted', 'accept');
    const stored = service.state().channelEvents.find((item) => item.id === decision.id)!; expect(stored).toMatchObject({ consumptionState: 'resolved', verdict: 'accept' }); service.close();
  });

  it('defers the same event, then resumes one new consumption episode without duplicate wake', async () => {
    const { service, cli, workspace, manager } = await fixture();
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'wait for worker', evidenceRefs: [] });
    await service.deferEvent(event.id, manager.member.id, { kind: 'defer', reason: 'waiting', resume: { kind: 'after', delayMs: 1 } });
    expect(service.state().channelEvents.find((item) => item.id === event.id)?.consumptionState).toBe('deferred'); const before = cli.sends; await new Promise((resolve) => setTimeout(resolve, 5)); await (service as any).pump();
    expect(service.state().deliveries.filter((item) => item.eventId === event.id)).toHaveLength(2); expect(cli.sends).toBe(before + 1); await (service as any).pump(); expect(cli.sends).toBe(before + 1); service.close();
  });

  it('keeps manual deferral through restart semantics until explicit resume queues one episode', async () => {
    const { root, service, cli, workspace, manager } = await fixture();
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'parked inbox item', evidenceRefs: [] });
    await service.deferEvent(event.id, manager.member.id, { kind: 'defer', reason: 'parked', resume: { kind: 'manual' } }); const before = cli.sends; service.close();
    const reopened = new ArcpService(root, cli as any); await reopened.init(); await (reopened as any).pump(); expect(cli.sends).toBe(before); expect(reopened.state().channelEvents.find((item) => item.id === event.id)?.consumptionState).toBe('deferred'); await reopened.resumeEvent(event.id, manager.member.id);
    expect(reopened.state().channelEvents.find((item) => item.id === event.id)?.consumptionState).toBe('open'); expect(reopened.state().deliveries.filter((item) => item.eventId === event.id)).toHaveLength(2); expect(cli.sends).toBe(before + 1); reopened.close();
  });

  it('reopens an event-dependent defer once when its dependency resolves', async () => {
    const { service, cli, workspace, manager } = await fixture();
    const dependency = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'decision_required', urgency: 'normal', consumptionPolicy: 'decision_required', decisionRequired: true, summary: 'choose base', evidenceRefs: [] });
    const waiting = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'wait for base', evidenceRefs: [] });
    await service.deferEvent(waiting.id, manager.member.id, { kind: 'defer', reason: 'depends on base', resume: { kind: 'event', eventId: dependency.id } }); const before = cli.sends;
    await service.resolveDecision(dependency.id, manager.member.id, 'use main', 'accept');
    expect(service.state().channelEvents.find((item) => item.id === waiting.id)?.consumptionState).toBe('open'); expect(service.state().deliveries.filter((item) => item.eventId === waiting.id)).toHaveLength(2); expect(cli.sends).toBe(before + 1); await (service as any).pump(); expect(cli.sends).toBe(before + 1); service.close();
  });

  it('keeps one parked-manager obligation across observations, explicit decisions, defer, and a stopped generation', async () => {
    const { service, cli, workspace, manager } = await fixture();
    const observation = { workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, semanticKey: 'permission:manager:1', kind: 'permission' as const, urgency: 'urgent' as const, consumptionPolicy: 'decision_required' as const, decisionRequired: true, summary: 'permission required', evidenceRefs: [] };
    const first = await service.publishChannelEvent(observation); const second = await service.publishChannelEvent(observation);
    expect(second.id).toBe(first.id); expect(service.state().channelEvents.filter((item) => item.semanticKey === observation.semanticKey)).toHaveLength(1);
    await expect(service.resolveDecision(first.id, manager.member.id, '' as any, undefined as any)).rejects.toMatchObject({ code: 'invalid_request' }); expect(service.state().channelEvents.find((item) => item.id === first.id)?.consumptionState).toBe('open');
    const parked = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'parked correction', evidenceRefs: [] }); await service.deferEvent(parked.id, manager.member.id, { kind: 'defer', reason: 'pause', resume: { kind: 'manual' } });
    const inbox: any[] = service.context(workspace.workspace.id, manager.member.id).inbox; expect(inbox.filter((item) => item.eventId === parked.id)).toHaveLength(1); expect(inbox.find((item) => item.eventId === parked.id)).toMatchObject({ facet: 'manual', deliveries: expect.any(Array) });
    await service.store.mutate((state: any) => { state.sessions.find((item: any) => item.id === 'manager-runtime').state = 'terminal'; }); await service.resumeEvent(first.id, manager.member.id); await (service as any).pump();
    const rerouted = service.state().channelEvents.find((item) => item.id === first.id)!; expect(rerouted).toMatchObject({ consumptionState: 'open', reroutedToMemberId: workspace.member.id }); expect(rerouted.dispositions.some((item) => item.kind === 'reroute')).toBe(true); expect(cli.sends).toBe(2); await expect(service.deferEvent(first.id, manager.member.id, { kind: 'defer', reason: 'late', resume: { kind: 'manual' } })).rejects.toMatchObject({ code: 'unauthorized' }); service.close();
  });
});
