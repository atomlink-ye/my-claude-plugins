import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecordingChannelAdapter } from '../../../../skills/agent-runtime-control-panel/runtime/src/actor-channel.js';
import { createControl } from '../support/create-control.js';

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
});
