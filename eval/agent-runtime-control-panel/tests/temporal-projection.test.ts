import { describe, expect, it } from 'vitest';
import { projectTemporal } from '../../../skills/agent-runtime-control-panel/runtime/src/temporal-projection.js';

const at = '2026-09-02T00:00:00.000Z';
const event = (id: string, kind: any, taskId?: string) => ({ id, workspaceId: 'w', taskId, kind, urgency: 'normal', decisionRequired: kind === 'decision_required', content: { summary: `${kind} fact`, evidenceRefs: [], contentHash: id, sensitivity: 'normal', retention: 'standard' }, deliveryState: 'queued', transitions: [{ state: 'queued', at }], createdAt: at });
const facts = (channelEvents: any[], extra: any = {}) => ({ channelEvents, deliveries: [], tasks: [{ id: 'task-done', workspaceId: 'w', title: 'Completed task', lifecycle: 'completed', fence: 1, createdAt: at, updatedAt: '2026-09-02T01:00:00.000Z' }, { id: 'task-live', workspaceId: 'w', title: 'Live blocker', lifecycle: 'claimed', fence: 1, createdAt: at, updatedAt: at }], results: [{ id: 'result-done', workspaceId: 'w', taskId: 'task-done', memberId: 'm', fence: 1, status: 'candidate', summary: 'accepted evidence', evidenceRefs: [], createdAt: at }], sessions: [], members: [{ id: 'm', workspaceId: 'w', label: 'Owner', role: 'manager', joinKind: 'native', capabilities: [], lifecycle: 'active', createdAt: at, updatedAt: at }], goals: [], knowledge: [], now: '2026-09-02T02:00:01.000Z', ...extra });

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
});
