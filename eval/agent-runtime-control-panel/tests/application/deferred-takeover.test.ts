import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createControl } from '../support/create-control.js';

const SLA = { urgent: 120_000, normal: 900_000 };

/**
 * A Worker Goal whose ReportingRoute names a primary handler, an observe-only
 * cc, and a dormant escalation target — the shape the whole round is about.
 */
async function routedGoal(options: { escalate?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-deferred-takeover-'));
  const { service } = await createControl(root);
  const owner = await service.registerActor({ clientIdentity: 'takeover-owner' });
  const created = await service.createWorkspace({ workspaceId: undefined, ownerActorId: owner.actor.id, purpose: 'deferred takeover' } as any);
  const workspace = created.workspace;
  const primary = (await service.joinWorkspace({ workspaceId: workspace.id, label: 'Primary Manager', role: 'manager' })).member;
  const observer = (await service.joinWorkspace({ workspaceId: workspace.id, label: 'CC Observer', role: 'manager' })).member;
  const backup = (await service.joinWorkspace({ workspaceId: workspace.id, label: 'Escalation Manager', role: 'manager' })).member;

  const started: any = await service.startManaged({
    actorId: owner.actor.id, workspaceId: workspace.id, title: 'routed goal', profileId: 'codex-worker', workspace: '/tmp',
    primaryHandlerMemberId: primary.id, ccMemberIds: [observer.id],
    ...(options.escalate === false ? {} : { escalationMemberIds: [backup.id] }),
  } as any);

  await service.claimTask(started.task.id, started.member.id, 0);
  await service.submitResult({
    workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate',
    summary: 'done', evidenceRefs: ['commit:abc'], expectedFence: 1,
    runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation,
  });

  const obligation = service.state().channelEvents.find((event) => event.consumptionPolicy === 'decision_required' && event.consumptionState === 'open')!;
  return { service, workspace, primary, observer, backup, started, obligation };
}

const reread = (service: any, id: string) => service.state().channelEvents.find((event: any) => event.id === id);

/** Set a Member's durable lifecycle. There is no public retire verb, and the
 * sweep reads durable state, so this arranges the fact under test directly. */
const setLifecycle = (service: any, memberId: string, lifecycle: string) =>
  service.store.mutate((state: any) => { state.members.find((m: any) => m.id === memberId).lifecycle = lifecycle; });

/** Hold every Member's lease open past a future clock, so an advanced `nowMs`
 * exercises the ACK-budget trigger rather than incidentally lapsing a lease. */
const holdLeases = (service: any, untilMs: number) =>
  service.store.mutate((state: any) => { for (const member of state.members) member.leaseExpiresAt = new Date(untilMs + 3_600_000).toISOString(); });
const openObligations = (service: any, taskId: string) =>
  service.state().channelEvents.filter((e: any) => e.taskId === taskId && ['ack_required', 'decision_required'].includes(e.consumptionPolicy) && e.consumptionState === 'open');

describe('Deferred takeover — an escalation target is dormant by default', () => {
  it('gives a named escalation Member nothing at all while the primary is live and inside its SLA', async () => {
    const { service, backup, obligation, started } = await routedGoal();

    // The route really does name an escalation target — dormancy is being
    // asserted against a live field, not against an empty list.
    expect(started.session.reportingRoute.escalationMemberIds).toEqual([backup.id]);
    expect(service.state().channelEvents.some((event) => event.targetMemberId === backup.id)).toBe(false);

    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now(), slaMs: SLA });
    expect(activated).toEqual([]);
    expect(reread(service, obligation.id).targetMemberId).toBe(obligation.targetMemberId);
    expect(reread(service, obligation.id).takeover).toBeUndefined();
    service.close();
  });
});

describe('Deferred takeover — activates only on positive, durable evidence', () => {
  it('takes over when the primary is observably gone, recording the trigger, evidence and time', async () => {
    const { service, primary, backup, obligation } = await routedGoal();
    await setLifecycle(service, primary.id, 'retired');

    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now(), slaMs: SLA });

    expect(activated).toEqual([expect.objectContaining({ eventId: obligation.id, fromMemberId: primary.id, toMemberId: backup.id, trigger: 'primary_unavailable' })]);
    const after = reread(service, obligation.id);
    expect(after.targetMemberId).toBe(backup.id);
    expect(after.takeover).toMatchObject({ fromMemberId: primary.id, toMemberId: backup.id, trigger: 'primary_unavailable' });
    expect(after.takeover.evidence).toContain(primary.id);
    expect(Number.isFinite(Date.parse(after.takeover.at))).toBe(true);
    service.close();
  });

  it('takes over when a live primary simply let the obligation outlive its ACK budget', async () => {
    const { service, primary, backup, obligation } = await routedGoal();
    const at = Date.now() + SLA.normal + 1_000;
    await holdLeases(service, at);

    const activated = await service.activateDeferredTakeovers({ nowMs: at, slaMs: SLA });

    expect(activated).toEqual([expect.objectContaining({ eventId: obligation.id, toMemberId: backup.id, trigger: 'ack_sla_expired' })]);
    const after = reread(service, obligation.id);
    expect(after.targetMemberId).toBe(backup.id);
    expect(after.takeover.trigger).toBe('ack_sla_expired');
    // The primary was never unavailable; the evidence must say what was seen.
    expect(after.takeover.evidence).toContain('ACK budget');
    expect(service.state().members.find((m) => m.id === primary.id)!.lifecycle).not.toBe('retired');
    service.close();
  });

  it('moves accountability instead of adding a second holder', async () => {
    const { service, primary, backup, started } = await routedGoal();
    const before = openObligations(service, started.task.id);
    const at = Date.now() + SLA.normal + 1_000;
    await holdLeases(service, at);

    await service.activateDeferredTakeovers({ nowMs: at, slaMs: SLA });

    const after = openObligations(service, started.task.id);
    expect(after).toHaveLength(before.length);
    expect(after.filter((e: any) => e.targetMemberId === backup.id)).toHaveLength(1);
    expect(after.some((e: any) => e.targetMemberId === primary.id)).toBe(false);
    service.close();
  });

  it('takes over once, so a repeated sweep re-derives the same durable row', async () => {
    const { service, obligation } = await routedGoal();
    const first = await service.activateDeferredTakeovers({ nowMs: Date.now() + SLA.normal + 1_000, slaMs: SLA });
    const recorded = reread(service, obligation.id).takeover;

    const second = await service.activateDeferredTakeovers({ nowMs: Date.now() + SLA.normal * 4, slaMs: SLA });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(reread(service, obligation.id).takeover).toEqual(recorded);
    service.close();
  });
});

describe('Deferred takeover — fails closed', () => {
  it('never activates on a route with no escalation target', async () => {
    const { service, obligation } = await routedGoal({ escalate: false });
    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now() + SLA.normal + 1_000, slaMs: SLA });
    expect(activated).toEqual([]);
    expect(reread(service, obligation.id).takeover).toBeUndefined();
    service.close();
  });

  it('treats an unobservable primary as unknown, not unavailable, so a lookup failure never hands accountability away', async () => {
    const { service, obligation, backup } = await routedGoal();
    // The obligation names a handler that resolves to no Member at all.
    await (service as any).store.mutate((state: any) => {
      state.channelEvents.find((e: any) => e.id === obligation.id).targetMemberId = 'member_vanished';
    });

    // Well inside the SLA: unavailability is the only thing that could fire.
    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now(), slaMs: SLA });

    expect(activated).toEqual([]);
    expect(reread(service, obligation.id).targetMemberId).toBe('member_vanished');
    expect(reread(service, obligation.id).takeover).toBeUndefined();
    expect(service.state().channelEvents.some((e) => e.targetMemberId === backup.id)).toBe(false);
    service.close();
  });

  it('leaves the obligation open on the primary when no escalation Member is itself eligible', async () => {
    const { service, primary, backup, obligation } = await routedGoal();
    await setLifecycle(service, backup.id, 'retired');
    await setLifecycle(service, primary.id, 'retired');

    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now(), slaMs: SLA });

    expect(activated).toEqual([]);
    const after = reread(service, obligation.id);
    expect(after.targetMemberId).toBe(primary.id);
    expect(after.consumptionState).toBe('open');
    expect(after.takeover).toBeUndefined();
    service.close();
  });

  it('never touches an obligation that is no longer open', async () => {
    const { service, workspace, primary, obligation } = await routedGoal();
    await service.resolveDecision(obligation.id, primary.id, 'approved', 'accept');

    const activated = await service.activateDeferredTakeovers({ nowMs: Date.now() + SLA.normal * 4, slaMs: SLA });

    expect(activated).toEqual([]);
    expect(reread(service, obligation.id).takeover).toBeUndefined();
    expect(workspace.id).toBeTruthy();
    service.close();
  });
});

describe('Deferred takeover — cc stays observe-only', () => {
  it('emits a cc copy that can never obligate, and that the takeover sweep never picks up', async () => {
    const { service, observer, started } = await routedGoal();

    const ccEvents = service.state().channelEvents.filter((event) => event.targetMemberId === observer.id);
    expect(ccEvents.length).toBeGreaterThan(0);
    for (const event of ccEvents) {
      expect(event.consumptionPolicy).toBe('consume_on_delivery');
      expect(event.decisionRequired).toBe(false);
      expect(['ack_required', 'decision_required']).not.toContain(event.consumptionPolicy);
      expect(event.expectedAction.kind).toBe('none');
    }
    // A cc copy is not an open obligation, so it never appears in the sweep.
    expect(openObligations(service, started.task.id).some((e: any) => e.targetMemberId === observer.id)).toBe(false);

    await service.activateDeferredTakeovers({ nowMs: Date.now() + SLA.normal * 4, slaMs: SLA });
    for (const event of service.state().channelEvents.filter((e) => e.targetMemberId === observer.id)) expect(event.takeover).toBeUndefined();
    service.close();
  });
});
