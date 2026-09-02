import { describe, expect, it } from 'vitest';
import { projectTemporal } from '../../../../skills/agent-runtime-control-panel/runtime/src/temporal-projection.js';

const at = '2026-09-02T00:00:00.000Z';
const event = (id: string, kind: any, taskId?: string) => ({ id, workspaceId: 'w', taskId, kind, urgency: 'normal', decisionRequired: kind === 'decision_required', content: { summary: `${kind} fact`, evidenceRefs: [], contentHash: id, sensitivity: 'normal', retention: 'standard' }, deliveryState: 'queued', transitions: [{ state: 'queued', at }], createdAt: at });
const facts = (channelEvents: any[], extra: any = {}) => ({ channelEvents, deliveries: [], tasks: [{ id: 'task-done', workspaceId: 'w', title: 'Completed task', lifecycle: 'completed', fence: 1, createdAt: at, updatedAt: '2026-09-02T01:00:00.000Z' }, { id: 'task-live', workspaceId: 'w', title: 'Live blocker', lifecycle: 'claimed', fence: 1, createdAt: at, updatedAt: at }], results: [{ id: 'result-done', workspaceId: 'w', taskId: 'task-done', memberId: 'm', fence: 1, status: 'candidate', summary: 'accepted evidence', evidenceRefs: [], createdAt: at }], sessions: [], members: [{ id: 'm', workspaceId: 'w', label: 'Owner', role: 'manager', joinKind: 'native', capabilities: [], lifecycle: 'active', createdAt: at, updatedAt: at }], goals: [], knowledge: [], nowMs: Date.parse('2026-09-02T02:00:01.000Z'), ...extra });

describe('TemporalProjection', () => {
  it('keeps Delivery transport distinct from machine-provable semantic disposition', () => {
    const projection = projectTemporal(facts([event('old-decision', 'decision_required', 'task-done'), event('live-blocker', 'blocker', 'task-live')]));
    const old = projection.reconciliation.find((item) => item.eventId === 'old-decision')!;
    expect(old).toMatchObject({ disposition: 'superseded', deterministic: true });
    expect(projection.cards.map((item) => item.id)).toEqual(['live-blocker']);
    expect(projection.problems.find((item) => item.id === 'old-decision')?.transport.state).toBe('queued');
  });

  it('marks ambiguous completed work for review and keeps an undelivered decision active', () => {
    const ambiguousFacts = facts([event('ambiguous', 'decision_required', 'task-done')], { results: [] });
    const ambiguous = projectTemporal(ambiguousFacts, 'problems').cards[0];
    expect(ambiguous).toMatchObject({ disposition: 'stale_requires_review' });
    expect(ambiguous.nextAction).toContain('Manager or Deputy');
  });

  it('detects completion-without-result and old-generation transport uncertainty', () => {
    const old = event('old-generation', 'transport_uncertainty');
    const done = event('completion-without-result', 'task_completed', 'task-live');
    const projection = projectTemporal(facts([old, done], { results: [], deliveries: [{ id: 'delivery', fromActorId: 'a', runtimeSessionId: 'runtime-old', generation: 1, body: '', command: 'normal', state: 'queued', eventId: 'old-generation', createdAt: at }], sessions: [{ id: 'runtime-old', actorId: 'a', goalId: 'g', bindingId: 'b', generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'p', provider: 'codex', model: 'm', state: 'terminal', createdAt: at }, { id: 'runtime-new', actorId: 'a', goalId: 'g', bindingId: 'b', generation: 2, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'p', provider: 'codex', model: 'm', state: 'running', createdAt: at }] }));
    expect(projection.reconciliation.find((item) => item.eventId === 'old-generation')).toMatchObject({ disposition: 'invalidated' });
    expect(projection.problems.find((item) => item.id === 'completion-without-result')?.problems).toContain('completion_without_result');
  });

  it('uses the canonical Channel projection and injected time, never raw event wording or a clock', () => {
    const raw = event('human-card', 'blocker', 'task-live'); raw.content.summary = 'blocker task_opaque999 must be fixed';
    const projection = projectTemporal(facts([raw]));
    expect(projection.generatedAt).toBe('2026-09-02T02:00:01.000Z');
    expect(projection.cards[0].headline).not.toContain('task_opaque999');
  });

  it('keeps a ready Task with a terminal Runtime as Manager-owned review debt, never completion', () => {
    const stranded = facts([], {
      tasks: [{ id: 'task-stranded', workspaceId: 'w', title: 'Stranded lane', lifecycle: 'ready', fence: 0, createdAt: at, updatedAt: at }],
      results: [],
      sessions: [{ id: 'runtime-old', actorId: 'a', goalId: 'g', taskId: 'task-stranded', bindingId: 'b', generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'p', provider: 'codex', model: 'm', state: 'terminal', createdAt: at }],
    });
    const card = projectTemporal(stranded, 'problems').cards[0];
    expect(card).toMatchObject({ disposition: 'stale_requires_review', owner: 'Manager/Deputy', refs: { taskId: 'task-stranded' } });
    expect(card.problems).toContain('terminal_runtime_without_completion');
    expect(card.nextAction).toContain('do not infer completion');
  });

  it('detects the delivery invariants: unreachable queued packets, generation mismatch, non-monotonic timestamps, and invalid safe points', () => {
    const queued = event('queued', 'attention', 'task-live'); queued.targetMemberId = 'missing';
    const waiting = event('waiting', 'attention', 'task-live'); waiting.deliveryState = 'queued';
    const delivery = { id: 'd', fromActorId: 'a', runtimeSessionId: 'r', generation: 1, body: '', command: 'normal', state: 'waiting_safe_point', eventId: 'waiting', createdAt: at, attemptedAt: '2026-09-01T23:00:00.000Z' };
    const projection = projectTemporal(facts([queued, waiting], { deliveries: [delivery], sessions: [{ id: 'r', actorId: 'a', goalId: 'g', bindingId: 'b', generation: 2, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'p', provider: 'codex', model: 'm', state: 'terminal', lastTurnState: 'idle', createdAt: at }] }), 'problems');
    expect(projection.cards.find((card) => card.id === 'queued')?.problems).toContain('overdue');
    expect(projection.cards.find((card) => card.id === 'waiting')?.problems).toEqual(expect.arrayContaining(['delivery_generation_mismatch', 'timestamp_nonmonotonic', 'safe_point_invalid']));
  });

  it('detects duplicate completions, source identity retries, and stewardship recursion without creating a new semantic completion', () => {
    const first = event('completion-1', 'task_completed', 'task-done'); first.resultId = 'result-done';
    const second = event('completion-2', 'task_completed', 'task-done'); second.resultId = 'result-done'; second.createdAt = '2026-09-02T00:01:00.000Z';
    const candidate = event('candidate-retry', 'task_candidate', 'task-done'); candidate.resultId = 'result-retry';
    const steward = event('steward', 'attention', 'task-steward');
    const projection = projectTemporal(facts([first, second, candidate, steward], { tasks: [...facts([], {}).tasks, { id: 'task-steward', workspaceId: 'w', title: 'Steward analysis', lifecycle: 'claimed', fence: 1, scope: 'steward_analysis', createdAt: at, updatedAt: at }], results: [...facts([], {}).results, { id: 'result-retry', workspaceId: 'w', taskId: 'task-done', memberId: 'm', fence: 1, status: 'candidate', summary: 'retry', evidenceRefs: [], sourceId: 'same-source', createdAt: '2026-09-02T00:02:00.000Z' }, { id: 'result-retry-2', workspaceId: 'w', taskId: 'task-done', memberId: 'm', fence: 1, status: 'candidate', summary: 'retry', evidenceRefs: [], sourceId: 'same-source', createdAt: '2026-09-02T00:03:00.000Z' }] }), 'problems');
    expect(projection.cards.find((card) => card.id === 'completion-2')).toMatchObject({ disposition: 'superseded' });
    expect(projection.cards.find((card) => card.id === 'candidate-retry')?.problems).toContain('duplicate');
    expect(projection.cards.find((card) => card.id === 'steward')).toMatchObject({ subject: { kind: 'workspace' } });
    expect(projection.cards.find((card) => card.id === 'steward')?.problems).toContain('steward_recursion');
  });

  it('keeps transport-failed decisions actionable and marks completion with no Result as missing acceptance evidence', () => {
    const decision = event('decision', 'decision_required', 'task-live'); decision.deliveryState = 'undeliverable'; decision.undeliverableReason = 'old runtime';
    const completion = event('no-result', 'task_completed', 'task-live');
    const projection = projectTemporal(facts([decision, completion], { results: [] }), 'problems');
    expect(projection.cards.find((card) => card.id === 'decision')).toMatchObject({ disposition: 'active', owner: 'Manager/Deputy' });
    expect(projection.cards.find((card) => card.id === 'decision')?.nextAction).toContain('transport failure does not close');
    expect(projection.cards.find((card) => card.id === 'no-result')?.problems).toContain('completion_without_result');
  });

  it('removes accepted and refused decisions from active obligations even when their resolution packet is undeliverable', () => {
    const accepted = event('accepted', 'decision_required', 'task-live'); accepted.decisionRequired = false; accepted.verdict = 'accept';
    const refused = event('refused', 'decision_required', 'task-live'); refused.decisionRequired = false;
    const refusal = event('refusal-record', 'decision_resolved', 'task-live'); refusal.relatedEventId = 'refused'; refusal.verdict = 'refuse'; refusal.deliveryState = 'undeliverable'; refusal.undeliverableReason = 'no live target runtime session';
    const projection = projectTemporal(facts([accepted, refused, refusal]));
    expect(projection.cards.map((card) => card.id)).not.toEqual(expect.arrayContaining(['accepted', 'refused']));
    expect(projection.problems.find((card) => card.id === 'accepted')?.problems).not.toContain('decision');
    expect(projection.problems.find((card) => card.id === 'refused')?.disposition).toBe('superseded');
  });

  it('discharges a candidate through its paired decision Result and makes unresolved blockers review debt', () => {
    const candidate = event('candidate', 'task_candidate', 'task-live'); candidate.resultId = 'candidate-result'; candidate.decisionRequired = true;
    const decision = event('candidate-decision', 'decision_required', 'task-live'); decision.resultId = 'candidate-result'; decision.relatedEventId = 'candidate'; decision.decisionRequired = false;
    const accepted = event('candidate-accepted', 'decision_resolved', 'task-live'); accepted.relatedEventId = 'candidate-decision'; accepted.verdict = 'accept';
    const blocker = event('old-blocker', 'blocker'); blocker.decisionRequired = true;
    const projection = projectTemporal(facts([candidate, decision, accepted, blocker], { results: [...facts([], {}).results, { id: 'candidate-result', workspaceId: 'w', taskId: 'task-live', memberId: 'm', fence: 1, status: 'candidate', summary: 'candidate', evidenceRefs: [], createdAt: at }] }));
    expect(projection.cards.map((card) => card.id)).not.toEqual(expect.arrayContaining(['candidate', 'old-blocker']));
    expect(projection.problems.find((card) => card.id === 'old-blocker')?.disposition).toBe('stale_requires_review');
  });

  it('keeps the frozen surface to active, problems, and one task causal chain', () => {
    const input = facts([event('old', 'decision_required', 'task-done'), event('live', 'blocker', 'task-live')]);
    expect(projectTemporal(input, 'active').cards.map((card) => card.id)).toEqual(['live']);
    expect(projectTemporal(input, 'problems').cards.map((card) => card.id)).toContain('old');
    expect(projectTemporal(input, { taskId: 'task-done' }).cards.map((card) => card.id)).toEqual(['old']);
  });
});
