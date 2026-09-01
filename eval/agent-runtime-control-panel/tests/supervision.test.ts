import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { SQLiteStateStore } from '../../../skills/agent-runtime-control-panel/runtime/src/state-store.js';
import { DURABLE_PROGRESS_EVENT_KINDS, NON_PROGRESS_EVENT_KINDS, evaluateSupervision, supervisionReviewId, type SupervisionView } from '../../../skills/agent-runtime-control-panel/runtime/src/supervision.js';

// A supervision clock is a parameter, never a wall clock: every instant below is
// derived from this base so a slow or loaded host cannot change an outcome.
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

class SilentCli {
  sends = 0;
  stops = 0;
  interrupts = 0;
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'send') { this.interrupts += 1; this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'start-turn') { this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'stop') { this.stops += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') return { value: { id: 'paseo-session-1', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}

const companionFor = (root: string) => ({ store: { dir: root }, postMessage: async () => ({ id: 'message-1', delivery: { status: 'pending' } }), deleteMessage: async () => ({}) });

async function control(root: string, store?: any) {
  const cli = new SilentCli();
  const service = new ArcpService(companionFor(root) as any, cli as any, store);
  await service.init();
  return { service, cli };
}

/** One Workspace, one claimed Task, one live manager runtime for delivery. */
async function scenario(root: string, store?: any) {
  const { service, cli } = await control(root, store);
  const { actor } = await service.registerActor({ clientIdentity: 'supervision-owner' });
  const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'supervision' });
  const manager = await service.joinWorkspace({ workspaceId: created.workspace.id, label: 'manager', role: 'manager' });
  const worker = await service.joinWorkspace({ workspaceId: created.workspace.id, label: 'worker', role: 'worker' });
  const goal = await service.createGoal({ actorId: actor.id, title: 'supervision goal', workspaceId: created.workspace.id });
  await service.store.mutate((state: any) => state.sessions.push({ id: 'supervision-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: created.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: at(0) }));
  // The subject is written directly at a pinned instant. Rewriting the createdAt
  // of an already-published ChannelEvent would violate the append-only journal,
  // so the fixture never publishes an event it then has to move in time.
  const task = { id: 'task_supervision_subject', workspaceId: created.workspace.id, title: 'bounded proof task', lifecycle: 'claimed' as const, ownerMemberId: worker.member.id, fence: 1, createdAt: at(0), updatedAt: at(0) };
  await service.store.mutate((state: any) => state.tasks.push({ ...task }));
  return { service, cli, workspace: created.workspace, owner: created.member, manager: manager.member, worker: worker.member, task };
}

const analysisEvents = (service: ArcpService, workspaceId: string) =>
  service.state().channelEvents.filter((event) => event.kind === 'workspace_analysis_required' && event.workspaceId === workspaceId);

describe('supervision budgets, state and reconciliation', () => {
  it('separates durable material progress from streamed progress and keepalives', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-progress-'));
    const { service, workspace, worker, task } = await scenario(root);
    await service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 10_000, cooldownMs: 60_000 });

    // Streamed progress: the ACP adapter emits `material_progress` for token,
    // tool-call and usage updates, and `phase_progress` for turn phases. Neither
    // is durable evidence, so neither may move the inactivity clock.
    // They are published through the real path and therefore carry a real,
    // LATER createdAt than every pinned instant below: if any of them counted,
    // the progress clock would jump past the whole fixture timeline.
    for (const kind of ['material_progress', 'phase_progress', 'attention', 'runtime_health'] as const) {
      await service.publishChannelEvent({ id: `streamed-${kind}`, workspaceId: workspace.id, taskId: task.id, targetRole: 'manager', kind, urgency: 'normal', decisionRequired: false, summary: `streamed ${kind}`, evidenceRefs: [], notify: false });
    }
    // Keepalives: the same runtime observation digest, one hundred times over.
    for (let tick = 0; tick < 100; tick += 1) await service.recordSupervisionSignal({ workspaceId: workspace.id, subjectId: task.id, kind: 'runtime_observation', digest: 'idle-no-change', observedAt: at(9_000 + tick) });

    expect(service.supervisionProgress(task.id)).toEqual({ at: at(0), source: 'subject_created' });
    expect(await service.evaluateSupervision(T0 + 10_000)).toHaveLength(1);
    expect(service.supervisionReviews(workspace.id)[0]).toMatchObject({ reason: 'inactivity_budget', lastProgressAt: at(0) });

    // Durable evidence, by contrast, does move the clock. A Knowledge entry for
    // the subject is the cheapest durable write an agent can make.
    await service.addKnowledge({ workspaceId: workspace.id, authorMemberId: worker.id, kind: 'learning', text: 'durable note', taskId: task.id });
    await service.store.mutate((state: any) => { state.knowledge.at(-1).createdAt = at(20_000); });
    expect(service.supervisionProgress(task.id)).toEqual({ at: at(20_000), source: 'knowledge' });
    // And a commit whose digest actually changed counts, while a repeat does not.
    await service.recordSupervisionSignal({ workspaceId: workspace.id, subjectId: task.id, kind: 'commit', digest: 'aaaaaaa', observedAt: at(30_000) });
    expect(service.supervisionProgress(task.id)).toEqual({ at: at(30_000), source: 'commit' });
    await service.recordSupervisionSignal({ workspaceId: workspace.id, subjectId: task.id, kind: 'commit', digest: 'aaaaaaa', observedAt: at(90_000) });
    expect(service.supervisionProgress(task.id)).toEqual({ at: at(30_000), source: 'commit' });
    expect(service.state().supervisionSignals.filter((signal) => signal.kind === 'commit')).toHaveLength(1);
    // A runtime observation that actually CHANGED is durable evidence, unlike
    // the hundred identical samples above.
    await service.recordSupervisionSignal({ workspaceId: workspace.id, subjectId: task.id, kind: 'runtime_observation', digest: 'turn-two-tool-result', observedAt: at(40_000) });
    expect(service.supervisionProgress(task.id)).toEqual({ at: at(40_000), source: 'runtime_observation' });
    service.close();
  });

  it('keeps every streamed and telemetry kind out of the durable progress vocabulary', () => {
    for (const kind of NON_PROGRESS_EVENT_KINDS) expect(DURABLE_PROGRESS_EVENT_KINDS.has(kind)).toBe(false);
    expect(NON_PROGRESS_EVENT_KINDS.has('material_progress')).toBe(true);
    expect(DURABLE_PROGRESS_EVENT_KINDS.has('task_candidate')).toBe(true);
  });

  it('turns a review-budget breach into one durable review that never kills, retries or duplicates work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-review-'));
    const { service, cli, workspace, task } = await scenario(root);
    await service.configureSupervision({ workspaceId: workspace.id, reviewAfterMs: 5_000, cooldownMs: 60_000, stewardProfileId: 'codex-worker' });
    const before = service.state();
    const sendsBefore = cli.sends;

    expect(await service.evaluateSupervision(T0 + 4_999)).toHaveLength(0);
    const [review] = await service.evaluateSupervision(T0 + 5_000);
    expect(review).toMatchObject({ workspaceId: workspace.id, subjectId: task.id, generation: 1, reason: 'review_budget', state: 'open', breachedAt: at(5_000), cooldownUntil: at(65_000) });

    const events = analysisEvents(service, workspace.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: review.eventId, taskId: task.id, urgency: 'urgent', decisionRequired: false, targetRole: 'manager' });
    expect(events[0].content.summary).toContain('Workspace analysis required');

    const after = service.state();
    // No kill, no retry, no duplicated work: the subject keeps its lifecycle,
    // fence and claim, no Result appears, and no runtime turn is started or
    // stopped. Elapsed time is not failure.
    expect(after.tasks.find((item) => item.id === task.id)).toMatchObject({ lifecycle: 'claimed', fence: 1, ownerMemberId: before.tasks[0].ownerMemberId });
    expect(after.results).toHaveLength(0);
    expect(after.sessions.map((session) => session.state)).toEqual(before.sessions.map((session) => session.state));
    expect(cli.stops).toBe(0);
    expect(cli.interrupts).toBe(0);
    expect(cli.sends).toBe(sendsBefore + 1); // exactly one manager delivery for the one analysis event
    expect(after.deliveries.filter((delivery) => delivery.eventId === review.eventId)).toHaveLength(1);
    expect(after.deliveries.every((delivery) => delivery.state !== 'withdrawn')).toBe(true);

    const acknowledged = await service.acknowledgeSupervisionReview(review.id, service.state().members.find((member) => member.role === 'manager')!.id);
    expect(acknowledged).toMatchObject({ state: 'acknowledged', id: review.id });
    await expect(service.acknowledgeSupervisionReview(review.id, service.state().members.find((member) => member.role === 'worker')!.id)).rejects.toMatchObject({ code: 'unauthorized' });
    service.close();
  });

  it('deduplicates one breach per subject and generation across many ticks and holds a cooldown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-dedupe-'));
    const { service, workspace, worker, task } = await scenario(root);
    // The cooldown is deliberately short so the two guards can be told apart:
    // a phase that runs entirely AFTER the cooldown has lapsed is held only by
    // the per-generation dedupe, and a phase inside the cooldown at a NEW
    // generation is held only by the cooldown.
    await service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 1_000, cooldownMs: 10_000 });

    // Phase 1, inside the cooldown: four hundred ticks across the breach.
    for (let tick = 0; tick < 400; tick += 1) await service.evaluateSupervision(T0 + 1_000 + tick * 10);
    expect(service.supervisionReviews(workspace.id)).toHaveLength(1);
    expect(analysisEvents(service, workspace.id)).toHaveLength(1);
    expect(service.state().results).toHaveLength(0);
    expect(service.state().tasks).toHaveLength(1);
    const first = service.supervisionReviews(workspace.id)[0];
    expect(first.cooldownUntil).toBe(at(11_000));

    // Phase 2, after the cooldown has lapsed, same generation, still no
    // progress. Only the per-generation dedupe can keep this quiet.
    for (let tick = 0; tick < 200; tick += 1) await service.evaluateSupervision(T0 + 12_000 + tick * 100);
    expect(service.supervisionReviews(workspace.id)).toEqual([first]);
    expect(analysisEvents(service, workspace.id)).toHaveLength(1);

    // Phase 3, a new generation once the cooldown has lapsed: exactly one more.
    await service.store.mutate((state: any) => { const item = state.tasks.find((entry: any) => entry.id === task.id); item.fence = 2; item.updatedAt = at(2_000); });
    for (let tick = 0; tick < 50; tick += 1) await service.evaluateSupervision(T0 + 40_000 + tick);
    const second = service.supervisionReviews(workspace.id);
    expect(second).toHaveLength(2);
    expect(second.map((review) => review.generation)).toEqual([1, 2]);
    expect(analysisEvents(service, workspace.id)).toHaveLength(2);
    expect(second[1].cooldownUntil).toBe(at(50_000));

    // Phase 4, a new generation INSIDE the fresh cooldown. Only the cooldown
    // can keep this quiet, since the dedupe key has changed.
    await service.store.mutate((state: any) => { const item = state.tasks.find((entry: any) => entry.id === task.id); item.fence = 3; item.updatedAt = at(2_000); });
    for (let tick = 0; tick < 50; tick += 1) await service.evaluateSupervision(T0 + 41_000 + tick);
    expect(service.supervisionReviews(workspace.id)).toHaveLength(2);

    // Durable progress at the newest generation ends the breaches entirely.
    await service.addKnowledge({ workspaceId: workspace.id, authorMemberId: worker.id, kind: 'learning', text: 'progress at the newest generation', taskId: task.id });
    await service.store.mutate((state: any) => { state.knowledge.at(-1).createdAt = at(59_500); });
    for (let tick = 0; tick < 50; tick += 1) await service.evaluateSupervision(T0 + 60_000 + tick);
    expect(service.supervisionReviews(workspace.id)).toHaveLength(2);
    service.close();
  });

  it('reports no breach for a subject and generation already under review, cooldown aside', () => {
    // The service layer also addresses a review by a content-derived id, so this
    // exercises the evaluator's own dedupe contract directly rather than through
    // the redundant guard downstream of it.
    const policy = { id: 'policy-1', workspaceId: 'workspace-1', inactivityAfterMs: 1_000, cooldownMs: 10_000, stewardProfileId: 'codex-worker', automatic: true, createdAt: at(0), updatedAt: at(0) };
    const subject = { id: 'task-1', workspaceId: 'workspace-1', generation: 1, lifecycle: 'claimed', createdAt: at(0), updatedAt: at(0) };
    const view: SupervisionView = { subjects: [subject], results: [], knowledge: [], events: [], signals: [], policies: [policy], reviews: [] };
    const [breach] = evaluateSupervision(view, T0 + 5_000);
    expect(breach).toMatchObject({ subjectId: 'task-1', generation: 1, reason: 'inactivity_budget', reviewId: supervisionReviewId('policy-1', 'task-1', 1, 'inactivity_budget') });

    // The recorded review, with its cooldown long lapsed at the instants below.
    const reviewed: SupervisionView = { ...view, reviews: [{ id: breach.reviewId, workspaceId: 'workspace-1', policyId: 'policy-1', subjectKind: 'task' as const, subjectId: 'task-1', generation: 1, reason: 'inactivity_budget' as const, eventId: breach.eventId, breachedAt: breach.breachedAt, lastProgressAt: breach.lastProgressAt, cooldownUntil: at(15_000), state: 'open' as const }] };
    expect(evaluateSupervision(reviewed, T0 + 100_000)).toEqual([]);
    expect(evaluateSupervision(reviewed, T0 + 10_000_000)).toEqual([]);
    // A later generation of the same subject is a different subject/generation
    // pair, so it may breach once the cooldown has lapsed.
    const regenerated: SupervisionView = { ...reviewed, subjects: [{ ...subject, generation: 2 }] };
    expect(evaluateSupervision(regenerated, T0 + 100_000).map((item) => item.generation)).toEqual([2]);
    // A disabled policy never breaches, whatever the elapsed time.
    expect(evaluateSupervision({ ...view, policies: [{ ...policy, automatic: false }] }, T0 + 10_000_000)).toEqual([]);
  });

  it('leaves an unclaimed or finished subject unsupervised', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-lifecycle-'));
    const { service, workspace, task } = await scenario(root);
    await service.configureSupervision({ workspaceId: workspace.id, reviewAfterMs: 1_000, cooldownMs: 10_000 });
    const idle = await service.createTask({ workspaceId: workspace.id, title: 'never claimed' });
    await service.store.mutate((state: any) => { const item = state.tasks.find((entry: any) => entry.id === idle.id); item.createdAt = at(0); item.updatedAt = at(0); });
    await service.store.mutate((state: any) => { const item = state.tasks.find((entry: any) => entry.id === task.id); item.lifecycle = 'completed'; });
    expect(await service.evaluateSupervision(T0 + 900_000)).toHaveLength(0);
    expect(service.supervisionReviews(workspace.id)).toHaveLength(0);
    service.close();
  });

  it('refuses a policy that has no budget, a bad budget or an unconfigured Steward profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-policy-'));
    const { service, workspace } = await scenario(root);
    await expect(service.configureSupervision({ workspaceId: workspace.id })).rejects.toMatchObject({ code: 'invalid_request', field: 'reviewAfterMs' });
    await expect(service.configureSupervision({ workspaceId: workspace.id, reviewAfterMs: 0 })).rejects.toMatchObject({ code: 'invalid_request', field: 'reviewAfterMs' });
    await expect(service.configureSupervision({ workspaceId: workspace.id, reviewAfterMs: 1_000, stewardProfileId: 'no-such-profile' })).rejects.toMatchObject({ code: 'invalid_request', field: 'stewardProfileId' });
    await expect(service.configureSupervision({ workspaceId: 'workspace-missing', reviewAfterMs: 1_000 })).rejects.toMatchObject({ code: 'not_found' });
    const policy = await service.configureSupervision({ workspaceId: workspace.id, reviewAfterMs: 1_000 });
    expect(policy).toMatchObject({ stewardProfileId: 'codex-worker', automatic: true, cooldownMs: 900_000 });
    // Disabling automatic supervision keeps the policy durable and silent.
    const disabled = await service.configureSupervision({ workspaceId: workspace.id, automatic: false });
    expect(disabled.id).toBe(policy.id);
    expect(service.state().supervisionPolicies).toHaveLength(1);
    expect(await service.evaluateSupervision(T0 + 900_000)).toHaveLength(0);
    service.close();
  });

  for (const [label, makeStore] of [
    ['the JSON state store', (_dir: string) => undefined],
    ['the SQLite state store', (dir: string) => new SQLiteStateStore(dir)],
  ] as const) {
    it(`carries budget and review state across a restart on ${label}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-supervision-restart-'));
      const { service, workspace, task } = await scenario(root, makeStore(root));
      await service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 5_000, cooldownMs: 200_000 });
      const [review] = await service.evaluateSupervision(T0 + 5_000);
      expect(service.supervisionReviews(workspace.id)).toHaveLength(1);
      expect(analysisEvents(service, workspace.id)).toHaveLength(1);
      service.close();
      (service.store as any).close?.();

      // Restart: a second service over the same durable directory.
      const { service: restarted, cli } = await control(root, makeStore(root));
      const policy = restarted.supervisionPolicy(workspace.id);
      expect(policy).toMatchObject({ inactivityAfterMs: 5_000, cooldownMs: 200_000, automatic: true, stewardProfileId: 'codex-worker' });
      // The breach itself survived, with its original instants intact. A review
      // re-created after the restart would carry a later breachedAt, so this
      // distinguishes "still recorded" from "recorded again".
      expect(restarted.supervisionReviews(workspace.id)).toEqual([review]);

      const sendsAfterRestart = cli.sends;
      for (let tick = 0; tick < 200; tick += 1) await restarted.evaluateSupervision(T0 + 6_000 + tick * 100);
      const reviews = restarted.supervisionReviews(workspace.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toEqual(review);
      expect(reviews[0].cooldownUntil).toBe(at(205_000));
      expect(analysisEvents(restarted, workspace.id)).toHaveLength(1);
      expect(restarted.state().deliveries.filter((delivery) => delivery.eventId === review.eventId)).toHaveLength(1);
      // No duplicate analysis: no second event, no second review, and no further
      // runtime turn started for the same breach after the restart.
      expect(cli.sends).toBe(sendsAfterRestart);
      expect(restarted.state().tasks.find((item) => item.id === task.id)).toMatchObject({ lifecycle: 'claimed', fence: 1 });
      expect(restarted.state().results).toHaveLength(0);
      restarted.close();
      (restarted.store as any).close?.();
    });
  }
});
