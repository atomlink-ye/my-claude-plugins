import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const execFileAsync = promisify(execFile);
import { RecordingChannelAdapter } from '../../../../skills/agent-runtime-control-panel/runtime/src/actor-channel.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

/** The proactive-channel canary.
 *
 * It walks the whole accountability chain in one run: a Worker candidate
 * reaches the accountable Manager, the Manager fails to act, the Owner Deputy
 * is woken through its channel binding, and its verdict releases the blocked
 * work. Each link is asserted, so a break anywhere fails loudly rather than
 * degrading into a silent dead letter. */
async function platformWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-owner-escalation-'));
  const { service } = await createControl(root);
  // The Owner Deputy lives OUTSIDE the Workspace roster and is reachable only
  // through its channel binding; that is the case the seam exists for.
  const owner = await service.registerActor({ clientIdentity: 'owner-deputy', label: 'Hermes Owner Deputy', channel: 'recording', conversationRef: 'conversation-opaque-1' });
  const workspace = await service.createWorkspace({ purpose: 'platform accountability canary', ownerActorId: owner.actor.id });
  const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'Claude Manager', role: 'manager' });
  const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'Worker', role: 'worker' });
  const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'blocked unit of work' });
  return { service, owner, ownerMember: workspace.member, workspace: workspace.workspace, manager: manager.member, worker: worker.member, task };
}

describe('owner escalation canary', () => {
  it('wakes the Manager, escalates once to the Owner channel, and resumes the blocked task on accept', async () => {
    const { service, workspace, ownerMember, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);

    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'candidate awaiting a decision', expectedFence: task.fence + 1 });

    // Link 1: the obligation is addressed to the accountable Manager, and the
    // Owner has not been woken merely because a candidate exists.
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id);
    expect(decision).toBeDefined();
    expect(decision!.targetMemberId ?? decision!.targetRole).toBeTruthy();
    expect(channel.wakes).toHaveLength(0);

    // Link 2: the Manager does not act and its SLA lapses, so accountability
    // moves outward rather than the obligation resting forever.
    const escalated = await service.escalateToOwnerActor({ eventId: decision!.id, reason: 'Manager ACK SLA expired on a candidate decision' });
    expect(escalated.alreadyEscalated).toBe(false);
    expect(escalated.receipt?.state).toBe('accepted');

    // Link 3: exactly one Owner obligation, addressed to the Actor, carrying no
    // prompt or private path into the adapter envelope.
    expect(channel.wakes).toHaveLength(1);
    expect(escalated.event.targetActorId).toBe(workspace.ownerActorId);
    expect(escalated.event.relatedEventId).toBe(decision!.id);
    expect(channel.wakes[0].envelope.recipientRef).toBe('conversation-opaque-1');
    expect(channel.wakes[0].binding.generation).toBe(1);
    expect(JSON.stringify(channel.wakes[0].envelope)).not.toMatch(/\/(Users|home|tmp)\//);

    // Link 4: a retried SLA tick must not wake a human a second time.
    const again = await service.escalateToOwnerActor({ eventId: decision!.id, reason: 'Manager ACK SLA expired on a candidate decision' });
    expect(again.alreadyEscalated).toBe(true);
    expect(channel.wakes).toHaveLength(1);
    expect(service.state().channelEvents.filter((event) => event.relatedEventId === decision!.id && event.kind === 'decision_required')).toHaveLength(1);

    // Link 5: the Owner verdict produces exactly one resolution and releases
    // the blocked work; a repeat resolve is idempotent, not a second effect.
    // Only the escalation's intended target may resolve it: the Owner Deputy,
    // never the Manager that failed to act and never the candidate's author.
    await service.resolveDecision(escalated.event.id, ownerMember.id, 'Owner Deputy accepted the escalated candidate', 'accept');
    const resolvedEvents = service.state().channelEvents.filter((event) => event.kind === 'decision_resolved' && event.relatedEventId === escalated.event.id);
    expect(resolvedEvents).toHaveLength(1);
    expect(service.state().tasks.find((item) => item.id === task.id)?.lifecycle).toBe('completed');

    await service.resolveDecision(escalated.event.id, ownerMember.id, 'duplicate verdict', 'accept');
    expect(service.state().channelEvents.filter((event) => event.kind === 'decision_resolved' && event.relatedEventId === escalated.event.id)).toHaveLength(1);
    service.close();
  });

  it('records a durable undeliverable escalation when the owner binding is superseded', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    const binding = service.state().bindings.find((item) => item.actorId === workspace.ownerActorId)!;
    service.channels.register(new RecordingChannelAdapter('recording', { supersededBindings: [binding.id] }));

    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'candidate awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;

    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'Manager ACK SLA expired' });
    // A refused wire is a durable, visible failure. It must never look like a
    // delivered escalation and must never silently vanish.
    expect(escalated.receipt?.state).toBe('refused');
    const stored = service.state().channelEvents.find((event) => event.id === escalated.event.id)!;
    expect(stored.deliveryState).toBe('undeliverable');
    expect(stored.consumptionState).toBe('open');
    service.close();
  });

  it('attaches a live participant to an existing Manager member so its obligations stop dead-lettering', async () => {
    const { service, workspace, manager } = await platformWorkspace();
    // Before attach the accountable Manager has a Member but no session, which
    // is precisely the state that produced "no live target runtime session".
    expect(service.state().sessions.filter((item) => item.memberId === manager.id)).toHaveLength(0);

    const session = await service.attachParticipant({ workspaceId: workspace.id, memberId: manager.id, adapterId: 'claude-code', externalId: 'participant-opaque-1' });
    expect(session.memberId).toBe(manager.id);
    expect(session.runtimeKind).toBe('external');
    expect(session.state).toBe('idle');
    // No Member was minted and nothing was launched.
    expect(service.state().members.filter((item) => item.workspaceId === workspace.id)).toHaveLength(3);

    // Re-attach is idempotent: a reconnect resumes one accountable session
    // rather than forking a second generation.
    const again = await service.attachParticipant({ workspaceId: workspace.id, memberId: manager.id, adapterId: 'claude-code', externalId: 'participant-opaque-1' });
    expect(again.id).toBe(session.id);
    expect(service.state().sessions.filter((item) => item.memberId === manager.id)).toHaveLength(1);

    // Silently redirecting a live session to another channel would reroute a
    // human's obligations without anyone noticing.
    await expect(service.attachParticipant({ workspaceId: workspace.id, memberId: manager.id, adapterId: 'other-channel', externalId: 'participant-opaque-2' }))
      .rejects.toMatchObject({ code: 'placement_conflict' });
    service.close();
  });

  it('does not wedge an attached participant into attention by diffing adapter identity against provider truth', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-attached-observe-'));
    const cli = new FakePaseoCli({ providers: ['claude'] });
    const { service } = await createControl(root, { cli });
    const owner = await service.registerActor({ clientIdentity: 'owner-deputy', label: 'Owner', channel: 'recording', conversationRef: 'c1' });
    const ws = await service.createWorkspace({ purpose: 'attached observe', ownerActorId: owner.actor.id });
    const manager = await service.joinWorkspace({ workspaceId: ws.workspace.id, label: 'Manager', role: 'manager' });
    const session = await service.attachParticipant({ workspaceId: ws.workspace.id, memberId: manager.member.id, adapterId: 'paseo', externalId: 'paseo-session-1' });

    const observed = await service.observe(session.id);
    // The adapter identity it was attached with is not a provider plan, so it
    // must never be diffed against what the provider actually reports.
    expect(observed.state).not.toBe('attention');
    // Underlying provider telemetry stays truthful rather than being erased.
    expect(observed.observed?.provider).toBe('claude');
    expect(observed.provider).toBe('claude');
    expect(observed.generation).toBe(1);
    const view = await service.runtimeStatus(session.id);
    expect(view.observation.mismatch).toBe(false);
    service.close();
  });

  it('escalates automatically on ACK SLA expiry and on a lapsed handler lease, exactly once each', async () => {
    const { service, workspace, manager, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;

    // Inside the SLA nothing escalates: an unhandled obligation is not yet a
    // failure, and waking the Owner early would train them to ignore wakes.
    expect(await service.escalateOverdueObligations({ nowMs: Date.parse(decision.createdAt) + 1_000 })).toHaveLength(0);
    expect(channel.wakes).toHaveLength(0);

    // Past the SLA it escalates without anyone asking.
    const fired = await service.escalateOverdueObligations({ nowMs: Date.parse(decision.createdAt) + 20 * 60_000 });
    expect(fired).toEqual([{ eventId: decision.id, reason: 'ack_sla_expired' }]);
    expect(channel.wakes).toHaveLength(1);

    // A repeated sweep must re-derive the same durable row, not wake again.
    expect(await service.escalateOverdueObligations({ nowMs: Date.parse(decision.createdAt) + 40 * 60_000 })).toHaveLength(0);
    expect(channel.wakes).toHaveLength(1);
    service.close();
  });

  it('retries an automatic escalation after its previously undeliverable Owner path recovers', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    // Model an earlier escalation that could not reach its Owner. Its durable
    // row remains causal history, but it must not permanently suppress SLA
    // recovery once an Owner binding is reachable again.
    await service.store.mutate((state: any) => {
      const original = state.channelEvents.find((event: any) => event.id === decision.id);
      state.channelEvents.push({ ...original, id: `${decision.id}:owner-escalation`, targetMemberId: undefined, targetActorId: workspace.ownerActorId, targetRole: undefined, kind: 'decision_required', deliveryState: 'undeliverable', consumptionState: 'open', transitions: [...original.transitions, { state: 'undeliverable', at: new Date().toISOString() }], dispositions: [], createdAt: new Date().toISOString() });
      return undefined;
    });
    const fired = await service.escalateOverdueObligations({ nowMs: Date.parse(decision.createdAt) + 20 * 60_000 });
    expect(fired).toEqual([{ eventId: decision.id, reason: 'ack_sla_expired' }]);
    expect(channel.wakes).toHaveLength(1);
    expect(service.state().channelEvents.find((event) => event.id === `${decision.id}:owner-escalation`)?.deliveryState).toBe('delivered');
    service.close();
  });

  it('treats a lapsed handler lease as immediate unreachability rather than waiting out the SLA', async () => {
    const { service, workspace, manager, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    // Address it explicitly at the Manager and expire that Manager's lease.
    await service.store.mutate((state: any) => {
      state.channelEvents.find((item: any) => item.id === decision.id).targetMemberId = manager.id;
      state.members.find((item: any) => item.id === manager.id).leaseExpiresAt = new Date(Date.parse(decision.createdAt) - 1_000).toISOString();
      return undefined;
    });
    // Well inside the ACK SLA, so only the lapsed lease can explain a wake.
    const fired = await service.escalateOverdueObligations({ nowMs: Date.parse(decision.createdAt) + 1_000 });
    expect(fired).toEqual([{ eventId: decision.id, reason: 'handler_lease_expired' }]);
    expect(channel.wakes).toHaveLength(1);
    service.close();
  });

  it('rebinds an Actor to a new conversation without changing identity, and wakes only the current generation', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    const before = service.state().bindings.find((item) => item.actorId === workspace.ownerActorId)!;

    const rebound = await service.rebindActor({ actorId: workspace.ownerActorId, channel: 'recording' as any, conversationRef: 'conversation-opaque-2' });
    // Identity is the Actor; only the address moved.
    expect(rebound.actorId).toBe(workspace.ownerActorId);
    expect(rebound.generation).toBe(before.generation + 1);
    expect(rebound.id).not.toBe(before.id);
    // The prior binding is retired explicitly rather than mutated in place, so
    // a wake already in flight against it stays explainable.
    const priorAfter = service.state().bindings.find((item) => item.id === before.id)!;
    expect(priorAfter.lifecycle).toBe('superseded');
    expect(priorAfter.conversationRef).toBe('conversation-opaque-1');
    // Rebinding to the same conversation is idempotent, not a generation bump.
    expect((await service.rebindActor({ actorId: workspace.ownerActorId, channel: 'recording' as any, conversationRef: 'conversation-opaque-2' })).id).toBe(rebound.id);

    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });
    // The wake must reach the CURRENT conversation at its exact generation.
    expect(channel.wakes).toHaveLength(1);
    expect(channel.wakes[0].envelope.recipientRef).toBe('conversation-opaque-2');
    expect(channel.wakes[0].binding.generation).toBe(2);
    expect(channel.wakes[0].binding.bindingId).toBe(rebound.id);
    service.close();
  });

  it('refuses to wake a retired conversation when every binding is superseded', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    // Retire every binding this Actor has. Identity survives; no address does.
    await service.store.mutate((state: any) => {
      for (const binding of state.bindings.filter((item: any) => item.actorId === workspace.ownerActorId)) { binding.lifecycle = 'superseded'; binding.supersededAt = new Date().toISOString(); }
      return undefined;
    });

    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });

    // Waking a retired conversation would deliver a live obligation into a dead
    // thread and report success. It must fail durably and visibly instead.
    expect(channel.wakes).toHaveLength(0);
    expect(escalated.receipt).toBeUndefined();
    const stored = service.state().channelEvents.find((event) => event.id === escalated.event.id)!;
    expect(stored.deliveryState).toBe('undeliverable');
    expect(stored.consumptionState).toBe('open');
    service.close();
  });

  it('registers channels only at startup and reports a configured-but-unwired channel instead of pretending', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-registry-'));
    const { service } = await createControl(root);
    // The shipped config declares Hermes and the ACP runtime adapter backs it,
    // so the channel is genuinely available without any chat transport.
    expect(service.channelDiscovery().some((item) => item.adapterId === 'hermes' && item.configured && item.available)).toBe(true);
    expect(service.channels.has('hermes')).toBe(true);

    // With no ACP adapter there is nothing to deliver through, and that must be
    // reported rather than registered behind a stub that accepts envelopes
    // nobody receives.
    const bare = (await createControl(await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-bare-')))).service;
    (bare as any).adapters.delete('hermes-acp');
    (bare as any).channels = new (service.channels.constructor as any)();
    (bare as any).registerConfiguredChannels([{ id: 'hermes', provider: 'builtin:hermes' }]);
    expect(bare.channelDiscovery().some((item) => item.adapterId === 'hermes' && item.configured && !item.available)).toBe(true);
    bare.close();
    service.close();
  });

  it('refuses a duplicate or unknown channel provider instead of skipping it quietly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-badconfig-'));
    const { service } = await createControl(root);
    const register = (service as any).registerConfiguredChannels.bind(service);
    // A silently skipped channel is indistinguishable from a healthy one with
    // no work, and the first symptom would be an escalation reaching nobody.
    expect(() => register([{ id: 'x', provider: 'module:/tmp/evil.mjs' }])).toThrow(/not available in core/);
    expect(() => register([{ id: 'hermes' }])).toThrow(/id and a provider/);
    service.close();
  });

  it('refuses to guess between two live Owner addresses at the same generation', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    service.channels.register(new RecordingChannelAdapter('recording'));
    // A second current binding at the same generation is an ambiguous identity.
    await service.store.mutate((state: any) => {
      const first = state.bindings.find((item: any) => item.actorId === workspace.ownerActorId);
      state.bindings.push({ ...first, id: 'binding_rival', conversationRef: 'conversation-rival' });
      return undefined;
    });
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });
    // Picking one would silently choose which human gets woken.
    expect(escalated.receipt).toBeUndefined();
    expect(service.state().channelEvents.find((e) => e.id === escalated.event.id)!.deliveryState).toBe('undeliverable');
    service.close();
  });

  it('offers an explicit, attributed disposition for a dead obligation and refuses live or decision ones', async () => {
    const { service, workspace, manager, worker, task } = await platformWorkspace();
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting', expectedFence: task.fence + 1 });
    const candidate = service.state().channelEvents.find((e) => e.kind === 'task_candidate' && e.resultId === result.id)!;
    const decision = service.state().channelEvents.find((e) => e.kind === 'decision_required' && e.resultId === result.id)!;
    expect(candidate.consumptionPolicy).toBe('consume_on_delivery');
    expect(decision.consumptionPolicy).toBe('decision_required');

    // A live obligation must keep its normal path: this disposition is only for
    // history that can never reach anyone.
    await service.store.mutate((state: any) => { state.channelEvents.find((e: any) => e.id === candidate.id).deliveryState = 'delivered'; return undefined; });
    await expect(service.disposeUndeliverable({ eventId: candidate.id, memberId: manager.id, reason: 'x' })).rejects.toMatchObject({ code: 'invalid_request' });
    await service.store.mutate((state: any) => { state.channelEvents.find((e: any) => e.id === candidate.id).deliveryState = 'undeliverable'; state.channelEvents.find((e: any) => e.id === decision.id).deliveryState = 'undeliverable'; return undefined; });
    // A decision still needs a verdict; it must not be swept away as dead history.
    await expect(service.disposeUndeliverable({ eventId: decision.id, memberId: manager.id, reason: 'x' })).rejects.toMatchObject({ code: 'invalid_request' });
    // A reason is mandatory: an unexplained disposal is indistinguishable from an auto-close.
    await expect(service.disposeUndeliverable({ eventId: candidate.id, memberId: manager.id, reason: '  ' })).rejects.toMatchObject({ code: 'invalid_request' });

    const disposed = await service.disposeUndeliverable({ eventId: candidate.id, memberId: manager.id, reason: 'dead history from before a Manager session existed' });
    expect(disposed.consumptionState).toBe('consumed');
    expect(disposed.dispositions.at(-1)).toMatchObject({ actorMemberId: manager.id });
    expect(disposed.dispositions.at(-1)!.reason).toContain('undeliverable disposition');
    expect(disposed.deliveryState).toBe('undeliverable');
    service.close();
  });

  it('keeps stale reconciliation proposals read-only until an accountable member records a disposition', async () => {
    const { service, workspace, manager } = await platformWorkspace();
    const stale = await service.publishChannelEvent({ workspaceId: workspace.id, targetMemberId: manager.id, kind: 'blocker', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: true, summary: 'historical blocker without a durable resolution', evidenceRefs: [], notify: false });
    const before = service.state().channelEvents.find((event) => event.id === stale.id)!;
    const proposal = service.temporalReconciliation(workspace.id).find((item) => item.eventId === stale.id)!;
    expect(proposal).toMatchObject({ disposition: 'stale_requires_review', deterministic: false });
    // Reconciliation computes an explanation; it never writes a disposition
    // or treats an ambiguous historical obligation as green.
    const after = service.state().channelEvents.find((event) => event.id === stale.id)!;
    expect(after.consumptionState).toBe('open');
    expect(after.dispositions).toEqual(before.dispositions);
    service.close();
  });

  it('wakes the Owner through a Hermes ACP prompt turn, never a human chat', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    // Replace the ACP runtime adapter with a recorder: the Owner channel must
    // reach an internal ACP session, and nothing here may touch a chat.
    const turns: Array<{ externalId: string; body: string; deliveryId: string }> = [];
    (service as any).adapters.set('hermes-acp', { id: 'hermes-acp', startTurn: async (externalId: string, body: string, deliveryId: string) => { turns.push({ externalId, body, deliveryId }); return {}; } });
    (service as any).channels = new ((service.channels as any).constructor)();
    (service as any).registerConfiguredChannels([{ id: 'hermes', provider: 'builtin:hermes' }]);
    await service.rebindActor({ actorId: workspace.ownerActorId, channel: 'hermes' as any, conversationRef: 'acp-session-opaque-1' });

    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;
    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'Manager ACK SLA expired' });

    expect(escalated.receipt?.state).toBe('accepted');
    expect(turns).toHaveLength(1);
    // The ACP session id is the whole address; no chat id, path or prompt text
    // about the recipient crosses this boundary.
    expect(turns[0].externalId).toBe('acp-session-opaque-1');
    expect(turns[0].deliveryId).toBe(escalated.event.id);
    expect(turns[0].body).toContain('[ARCP escalation]');
    expect(turns[0].body).not.toMatch(/oc_|om_|feishu|lark|\/(Users|home)\//i);
    // A retried escalation must not start a second turn.
    await service.escalateToOwnerActor({ eventId: decision.id, reason: 'Manager ACK SLA expired' });
    expect(turns).toHaveLength(1);
    service.close();
  });

  it('parents a launch on the launcher live provider identity and holds when it cannot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-lineage-'));
    const cli = new FakePaseoCli({ providers: ['codex'] });
    const { service } = await createControl(root, { cli });
    const owner = await service.registerActor({ clientIdentity: 'owner', label: 'Owner', channel: 'local' });
    const ws = await service.createWorkspace({ purpose: 'lineage', ownerActorId: owner.actor.id });
    const manager = await service.joinWorkspace({ workspaceId: ws.workspace.id, label: 'Manager', role: 'manager' });

    // A launcher with no live provider identity must fail closed. Silently
    // rooting the child would destroy the parent link with no way to recover it.
    // Count every durable surface a held launch could touch, not just the three
    // I first thought of: placement and ExecutionSurface are created by
    // resolvePaseoPlacement and are exactly what an early hold must not leave.
    const snapshot = () => { const st: any = service.state(); return { goals: st.goals.length, tasks: st.tasks.length, members: st.members.length, surfaces: (st.executionSurfaces ?? []).length, claims: (st.surfaceClaims ?? []).length, sessions: st.sessions.length, workspacePlacements: JSON.stringify((st.workspaces ?? []).map((w: any) => w.paseoPlacements ?? null)) }; };
    const before = snapshot();
    const paseoCallsBefore = cli.calls.length;
    const held = await service.startManaged({ actorId: owner.actor.id, workspaceId: ws.workspace.id, title: 'child', profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: root } as any);
    expect(held).toMatchObject({ action: 'hold', launchable: false });
    expect((held as any).why).toContain('LINEAGE_UNRESOLVED');
    // A hold must leave nothing behind. Repeating a blocked start would
    // otherwise accumulate orphan Goals, Tasks and member credentials while
    // still reporting that nothing happened.
    await service.startManaged({ actorId: owner.actor.id, workspaceId: ws.workspace.id, title: 'child', profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: root } as any);
    expect(snapshot()).toEqual(before);
    expect(cli.calls.slice(paseoCallsBefore).filter((args) => args[0] === 'workspace' || args[0] === 'project')).toEqual([]);
    // The ambiguous-launcher path must be as clean as the unresolved one.

    // With exactly one live identity the child is parented on it.
    await service.attachParticipant({ workspaceId: ws.workspace.id, memberId: manager.member.id, adapterId: 'paseo', externalId: 'parent-agent-1' });
    const started = await service.startManaged({ actorId: owner.actor.id, workspaceId: ws.workspace.id, title: 'child', profileId: 'codex-worker', launchedByMemberId: manager.member.id, parentAgentId: 'forged-parent-id', workspace: root } as any);
    expect('session' in started).toBe(true);
    // Lineage must reach the provider as the calling identity, not as a label.
    expect(cli.lastEnv).toBeDefined();
    const runCall = cli.calls.find((args) => args[0] === 'run');
    expect(runCall).toBeDefined();
    expect((started as any).session.reportingRoute.launchedByMemberId).toBe(manager.member.id);
    // The durable parent proof is the server-resolved live provider identity,
    // paired with the accountable Manager member. Caller input never wins.
    expect((started as any).session.parentAgentId).toBe('parent-agent-1');
    expect((started as any).session.parentAgentId).not.toBe('forged-parent-id');

    // The ambiguous-launcher path must be as clean as the unresolved one: a
    // second live identity makes the parent unknowable, and a hold there must
    // also leave no placement, surface or session behind.
    await service.store.mutate((st: any) => {
      const one = st.sessions.find((x: any) => x.memberId === manager.member.id && x.runtimeKind === 'external');
      st.sessions.push({ ...one, id: 'runtime_rival_b', externalId: 'parent-rival' });
      return undefined;
    });
    const ambiguousBefore = snapshot();
    const ambiguous = await service.startManaged({ actorId: owner.actor.id, workspaceId: ws.workspace.id, title: 'child', profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: root } as any);
    expect((ambiguous as any).why).toContain('LINEAGE_AMBIGUOUS');
    expect(snapshot()).toEqual(ambiguousBefore);
    service.close();
  });

  it('resolves launcher lineage on the direct launch path, not only on managed start', async () => {
    // startManaged is not the only door: /v1/runtime-sessions reaches launch()
    // directly. Both entry points now name a launcher member, so both must
    // resolve the provider parent from durable state and fail closed. Without
    // this the HTTP boundary hardening could be undone on the direct path with
    // the managed-start canary still green.
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-lineage-direct-'));
    const cli = new FakePaseoCli({ providers: ['codex'] });
    const { service } = await createControl(root, { cli });
    const owner = await service.registerActor({ clientIdentity: 'owner', label: 'Owner', channel: 'local' });
    const ws = await service.createWorkspace({ purpose: 'lineage-direct', ownerActorId: owner.actor.id });
    const manager = await service.joinWorkspace({ workspaceId: ws.workspace.id, label: 'Manager', role: 'manager' });
    const goalFor = async (title: string) => (await service.createGoal({ actorId: owner.actor.id, title, workspaceId: ws.workspace.id })).id;

    const sessionsBefore = (service.state() as any).sessions.length;
    await expect(service.launch({ actorId: owner.actor.id, goalId: await goalFor('held'), workspaceId: ws.workspace.id, profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: root } as any))
      .rejects.toThrow(/LINEAGE_UNRESOLVED/);
    expect((service.state() as any).sessions).toHaveLength(sessionsBefore);

    await service.attachParticipant({ workspaceId: ws.workspace.id, memberId: manager.member.id, adapterId: 'paseo', externalId: 'direct-parent-1' });
    // A caller-supplied parentAgentId is present and wrong on purpose: the
    // server-resolved live identity must win over anything the request names.
    const session = await service.launch({ actorId: owner.actor.id, goalId: await goalFor('parented'), workspaceId: ws.workspace.id, profileId: 'codex-worker', launchedByMemberId: manager.member.id, parentAgentId: 'forged-direct-parent', workspace: root } as any);
    expect(session.parentAgentId).toBe('direct-parent-1');

    await service.store.mutate((st: any) => {
      const one = st.sessions.find((x: any) => x.memberId === manager.member.id && x.runtimeKind === 'external');
      st.sessions.push({ ...one, id: 'runtime_direct_rival', externalId: 'direct-parent-rival' });
      return undefined;
    });
    const ambiguousBefore = (service.state() as any).sessions.length;
    await expect(service.launch({ actorId: owner.actor.id, goalId: await goalFor('ambiguous'), workspaceId: ws.workspace.id, profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: root } as any))
      .rejects.toThrow(/LINEAGE_AMBIGUOUS/);
    expect((service.state() as any).sessions).toHaveLength(ambiguousBefore);
    service.close();
  });

  it('lets only an intended recipient dispose a Manager-targeted obligation', async () => {
    const { service, workspace, manager, worker, task } = await platformWorkspace();
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting', expectedFence: task.fence + 1 });
    const candidate = service.state().channelEvents.find((e) => e.kind === 'task_candidate' && e.resultId === result.id)!;
    await service.store.mutate((state: any) => { const e = state.channelEvents.find((x: any) => x.id === candidate.id); e.deliveryState = 'undeliverable'; e.targetRole = 'manager'; return undefined; });

    // Membership is not accountability: a worker must not be able to clear a
    // Manager's queue just by being in the same Workspace.
    await expect(service.disposeUndeliverable({ eventId: candidate.id, memberId: worker.id, reason: 'not mine to retire' }))
      .rejects.toMatchObject({ code: 'unauthorized' });
    const disposed = await service.disposeUndeliverable({ eventId: candidate.id, memberId: manager.id, reason: 'addressed to me and unreachable' });
    expect(disposed.consumptionState).toBe('consumed');
    service.close();
  });

  it('records an in-flight escalation as indeterminate rather than retrying or calling it done', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    const channel = new RecordingChannelAdapter('recording');
    service.channels.register(channel);
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((e) => e.kind === 'decision_required' && e.resultId === result.id)!;
    await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });
    expect(channel.wakes).toHaveLength(1);

    // Real crash simulation: the wire accepts, then the process dies before the
    // receipt is written. Forcing an unreachable state would prove nothing, so
    // the adapter records the wake and then throws exactly where a crash would.
    await service.store.mutate((state: any) => { const e = state.channelEvents.find((x: any) => x.id === `${decision.id}:owner-escalation`); e.deliveryState = 'queued'; e.consumptionState = 'open'; return undefined; });
    (service.channels as any).adapters.set('recording', { id: 'recording', capabilities: () => ({ adapterId: 'recording', outboundWake: true, inboundReceipts: false }), validate: async () => ({ bindingId: 'b', generation: 1, state: 'current' }), deliver: async (b: any, env: any) => { channel.wakes.push({ binding: b, envelope: env }); throw new Error('process died after the send was accepted'); } });
    await expect(service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' })).rejects.toThrow();
    expect(channel.wakes).toHaveLength(2);
    const midFlight = service.state().channelEvents.find((e) => e.id === `${decision.id}:owner-escalation`)!;
    expect(midFlight.deliveryState).toBe('transport_indeterminate');

    service.channels.register(new RecordingChannelAdapter('recording2'));
    const again = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });
    // Neither a second wake nor a silent success: an explicit indeterminate.
    expect(again.indeterminate).toBe(true);
    // No third wake: an unknown outcome is reconciled, never re-sent.
    expect(channel.wakes).toHaveLength(2);
    const stored = service.state().channelEvents.find((e) => e.id === `${decision.id}:owner-escalation`)!;
    expect(stored.deliveryState).toBe('transport_indeterminate');
    expect(stored.undeliverableReason).toContain('indeterminate');
    service.close();
  });

  it('does not let one channel generation counter outrank another channel', async () => {
    const { service, workspace, worker, task } = await platformWorkspace();
    service.channels.register(new RecordingChannelAdapter('recording'));
    service.channels.register(new RecordingChannelAdapter('other'));
    // Generations are per channel. A higher counter on a second channel must
    // not make that channel win the address.
    await service.store.mutate((state: any) => {
      const first = state.bindings.find((b: any) => b.actorId === workspace.ownerActorId);
      state.bindings.push({ ...first, id: 'binding_other_ch', channel: 'other', generation: 9, conversationRef: 'other-conversation' });
      return undefined;
    });
    await service.claimTask(task.id, worker.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: worker.id, status: 'candidate', summary: 'awaiting', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((e) => e.kind === 'decision_required' && e.resultId === result.id)!;
    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'SLA expired' });
    expect(escalated.receipt).toBeUndefined();
    expect(service.state().channelEvents.find((e) => e.id === escalated.event.id)!.deliveryState).toBe('undeliverable');
    service.close();
  });

  it('reaches no placement or provider call when the launcher cannot be parented', async () => {
    // The earlier attempt at this could not fail: its workspace root was a
    // plain temp directory, so resolvePaseoPlacement never reached
    // materializePlacement and no provider call happened either way. A real Git
    // checkout is what makes the ordering observable.
    const repo = await mkdtemp(path.join(os.tmpdir(), 'arcp-lineage-repo-'));
    await execFileAsync('git', ['init', '-q', repo]);
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'root']);
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-lineage-data-'));
    const cli = new FakePaseoCli({ providers: ['codex'] });
    const { service } = await createControl(root, { cli });
    const owner = await service.registerActor({ clientIdentity: 'owner', label: 'Owner', channel: 'local' });
    const ws = await service.createWorkspace({ purpose: 'lineage placement', ownerActorId: owner.actor.id });
    const manager = await service.joinWorkspace({ workspaceId: ws.workspace.id, label: 'Manager', role: 'manager' });

    const before = cli.calls.length;
    const held = await service.startManaged({ actorId: owner.actor.id, workspaceId: ws.workspace.id, title: 'child', profileId: 'codex-worker', launchedByMemberId: manager.member.id, workspace: repo } as any);
    expect(held).toMatchObject({ action: 'hold', launchable: false });
    // A launcher that cannot be parented must not cause ARCP to create a
    // provider workspace or persist a surface on the way to refusing.
    expect(cli.calls.slice(before).filter((args) => args[0] === 'project' || args[0] === 'workspace')).toEqual([]);
    expect((service.state() as any).executionSurfaces ?? []).toHaveLength(0);
    service.close();
  });
});
