import { describe, expect, it } from 'vitest';
import { projectControlPanorama, renderControlPanorama, UNKNOWN, type ControlPanoramaFacts } from '../../../../skills/agent-runtime-control-panel/runtime/src/control-panorama.js';

const WS = 'workspace-1';
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const session = (over: Record<string, unknown> = {}) => ({
  id: 'runtime-1', actorId: 'actor-1', goalId: 'goal-1', taskId: 'task-1', bindingId: 'binding-1',
  generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: WS, memberId: 'member-worker',
  profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'running', createdAt: at(60), ...over,
}) as any;

const member = (id: string, role: string) => ({ id, workspaceId: WS, joinKind: 'managed', label: id, role, capabilities: [], lifecycle: 'active', createdAt: at(90), updatedAt: at(90) }) as any;
const goal = () => ({ id: 'goal-1', actorId: 'actor-1', title: 'ship the checkpoint', workspaceId: WS, state: 'active', createdAt: at(90), updatedAt: at(90) }) as any;
const task = (over: Record<string, unknown> = {}) => ({ id: 'task-1', workspaceId: WS, title: 'do the work', lifecycle: 'claimed', fence: 1, createdAt: at(90), updatedAt: at(60), ...over }) as any;
const result = (over: Record<string, unknown> = {}) => ({ id: 'result-1', workspaceId: WS, taskId: 'task-1', memberId: 'member-worker', fence: 1, status: 'candidate', summary: 'done', evidenceRefs: ['commit:40def2e5c32a721e47c4fefbd95901893e4a07c2'], createdAt: at(10), ...over }) as any;

const obligation = (over: Record<string, unknown> = {}) => ({
  id: 'event-1', workspaceId: WS, taskId: 'task-1', kind: 'decision_required', urgency: 'normal', priority: 'normal',
  consumptionPolicy: 'decision_required', consumptionState: 'open', expectedAction: { kind: 'resolve', instruction: '' },
  dispositions: [], decisionRequired: true, content: { summary: 'needs a call', evidenceRefs: [], contentHash: 'h', sensitivity: 'normal', retention: 'standard' },
  deliveryState: 'delivered', transitions: [], createdAt: at(45), deliveredAt: at(45), ...over,
}) as any;

const facts = (over: Partial<ControlPanoramaFacts> = {}): ControlPanoramaFacts => ({
  workspaceId: WS, workspacePurpose: 'campaign workspace', nowMs: NOW,
  sessions: [session()], members: [member('member-worker', 'worker'), member('member-manager', 'manager')],
  goals: [goal()], tasks: [task()], results: [], events: [], ...over,
});

describe('Control panorama — one bounded answer', () => {
  it('reports runtimes with role and state, the current Goal/Task, and the checkpoint SHA from the Result evidence', () => {
    const panorama = projectControlPanorama(facts({ results: [result()] }));

    expect(panorama.runtimes).toEqual([{ runtimeId: 'runtime-1', role: 'worker', memberId: 'member-worker', provider: 'codex', state: 'running' }]);
    expect(panorama.goal).toMatchObject({ id: 'goal-1', state: 'active' });
    expect(panorama.task).toMatchObject({ id: 'task-1', lifecycle: 'claimed', fence: 1 });
    expect(panorama.latestResult).toMatchObject({ id: 'result-1', status: 'candidate' });
    expect(panorama.checkpointSha).toBe('40def2e5c32a721e47c4fefbd95901893e4a07c2');
  });

  it('maps every session state onto the four control states a human reads', () => {
    const states = ['running', 'idle', 'attention', 'terminal', 'launching', 'placement_mismatch', 'transport_indeterminate'];
    const panorama = projectControlPanorama(facts({ sessions: states.map((state, index) => session({ id: `runtime-${index}`, state })) }));
    expect(panorama.runtimes.map((item) => item.state)).toEqual(['running', 'idle', 'attention', 'terminal', 'idle', 'attention', 'attention']);
  });

  it('counts open obligations and takeovers, and ages the oldest from supplied facts', () => {
    const panorama = projectControlPanorama(facts({
      events: [
        obligation({ id: 'event-old', deliveredAt: at(45) }),
        obligation({ id: 'event-new', consumptionPolicy: 'ack_required', deliveredAt: at(5) }),
        obligation({ id: 'event-done', consumptionState: 'resolved' }),
        obligation({ id: 'event-took', consumptionState: 'open', takeover: { toMemberId: 'member-manager', trigger: 'ack_sla_expired', evidence: 'budget passed', at: at(3) } }),
      ],
    }));

    // event-old and event-took; event-new is an ACK and event-done is resolved.
    expect(panorama.pending.decisions).toBe(2);
    expect(panorama.pending.acks).toBe(1);
    expect(panorama.pending.takeovers).toBe(1);
    expect(panorama.pending.oldestOpenAgeMs).toBe(45 * 60_000);
    expect(panorama.pending.oldestOpenEventId).toBe('event-old');
  });

  it('surfaces the most recent disposition with its reason and evidence', () => {
    const panorama = projectControlPanorama(facts({
      events: [
        obligation({ id: 'event-resolved', consumptionState: 'resolved', verdict: 'accept', resolvedAt: at(20), targetMemberId: 'member-manager', content: { summary: 'accepted the candidate', evidenceRefs: ['arcp://doc/d@1#sha256:ab'], contentHash: 'h', sensitivity: 'normal', retention: 'standard' } }),
        obligation({ id: 'event-took', takeover: { fromMemberId: 'member-manager', toMemberId: 'member-worker', trigger: 'primary_unavailable', evidence: 'handler retired', at: at(2) } }),
      ],
    }));

    expect(panorama.latestDisposition).toMatchObject({ eventId: 'event-took', kind: 'takeover_primary_unavailable', actor: 'member-worker', reason: 'handler retired' });
  });
});

describe('Control panorama — unknown is a value, never a guess', () => {
  it('reports unknown for every fact it cannot establish rather than omitting or inferring it', () => {
    const panorama = projectControlPanorama({ workspaceId: WS, nowMs: NOW, sessions: [], members: [], goals: [], tasks: [], results: [], events: [] });

    expect(panorama.purpose).toBe(UNKNOWN);
    expect(panorama.goal).toBe(UNKNOWN);
    expect(panorama.task).toBe(UNKNOWN);
    expect(panorama.latestResult).toBe(UNKNOWN);
    expect(panorama.checkpointSha).toBe(UNKNOWN);
    expect(panorama.latestDisposition).toBe(UNKNOWN);
    expect(panorama.providerBudget).toBe(UNKNOWN);
    expect(panorama.campaign).toBe(UNKNOWN);
    expect(panorama.pending.oldestOpenAgeMs).toBe(UNKNOWN);
    expect(panorama.pending.oldestOpenEventId).toBe(UNKNOWN);
  });

  it('leaves the checkpoint unknown when the Result carries no commit-shaped evidence, rather than inventing one', () => {
    const panorama = projectControlPanorama(facts({ results: [result({ evidenceRefs: ['arcp://doc/d@1#sha256:abc', 'see the branch'] })] }));
    expect(panorama.checkpointSha).toBe(UNKNOWN);
  });

  it('scopes strictly to its own workspace', () => {
    const panorama = projectControlPanorama(facts({
      sessions: [session(), session({ id: 'other', workspaceId: 'workspace-2' })],
      events: [obligation({ id: 'foreign', workspaceId: 'workspace-2' })],
    }));
    expect(panorama.runtimes.map((item) => item.runtimeId)).toEqual(['runtime-1']);
    expect(panorama.pending.decisions).toBe(0);
  });
});

describe('Control panorama — nextTrigger, and idle is never completion', () => {
  it('ranks an open decision above everything else', () => {
    const panorama = projectControlPanorama(facts({ events: [obligation()], campaign: { campaignState: 'active', nextContractRef: 'rounds/next/goal-contract.md' } }));
    expect(panorama.nextTriggerReason).toBe('owner_decision_pending');
    expect(panorama.nextTrigger).toContain('event-1');
  });

  it('ranks an open ACK above agent work', () => {
    const panorama = projectControlPanorama(facts({ events: [obligation({ consumptionPolicy: 'ack_required', decisionRequired: false })] }));
    expect(panorama.nextTriggerReason).toBe('ack_pending');
  });

  it('reports a claimed Task with no Result as still owed, even when every runtime is idle', () => {
    const panorama = projectControlPanorama(facts({ sessions: [session({ state: 'idle' })], tasks: [task({ lifecycle: 'claimed' })], results: [] }));

    expect(panorama.nextTriggerReason).toBe('awaiting_result');
    expect(panorama.nextTrigger).toContain('an idle runtime is not a finished one');
  });

  it('falls through to the campaign queue only once nothing is owed', () => {
    const panorama = projectControlPanorama(facts({
      sessions: [session({ state: 'terminal' })], tasks: [task({ lifecycle: 'completed' })], results: [result()],
      campaign: { campaignState: 'active', nextContractRef: 'rounds/next/goal-contract.md', nextLaunchBy: '2026-09-03T14:07:00+08:00', stopAuthority: 'none' },
    }));

    expect(panorama.nextTriggerReason).toBe('campaign_next_round');
    expect(panorama.nextTrigger).toContain('rounds/next/goal-contract.md');
    expect(panorama.campaign).toMatchObject({ campaignState: 'active', stopAuthority: 'none' });
    // Caller-supplied round facts are surfaced, never inferred from state.
    expect(panorama.campaign).toMatchObject({ currentRound: UNKNOWN, checkpointSha: UNKNOWN });
  });

  it('says plainly that nothing is running and nothing is open', () => {
    const panorama = projectControlPanorama(facts({ sessions: [], tasks: [task({ lifecycle: 'completed' })], results: [result()] }));
    expect(panorama.nextTriggerReason).toBe('idle_no_pending_work');
    expect(panorama.nextTrigger).toContain('Nothing is running');
  });
});

describe('Control panorama — the Markdown is the same projection', () => {
  it('renders every section from the projection a human needs', () => {
    const panorama = projectControlPanorama(facts({
      results: [result()], events: [obligation()],
      admission: { action: 'drain', providerId: 'codex', model: 'gpt-5.6-terra', reasons: ['weekly window is draining'] },
      budgetSource: { id: 'operator', observedAt: at(1), trust: 'authoritative' },
      campaign: { campaignState: 'active', nextContractRef: 'rounds/next/goal-contract.md' },
    }));
    const markdown = renderControlPanorama(panorama);

    expect(markdown).toContain('# Control panorama');
    for (const heading of ['## Running', '## Work', '## Awaiting action', '## Latest disposition', '## Capacity', '## Campaign', '## Next']) expect(markdown).toContain(heading);
    expect(markdown).toContain('40def2e5c32a721e47c4fefbd95901893e4a07c2');
    expect(markdown).toContain('drain');
    expect(markdown).toContain('owner_decision_pending');
    // The campaign block is labelled so a reader never mistakes caller-supplied
    // facts for control-plane truth.
    expect(markdown).toContain('caller-supplied, not control-plane truth');
    // Unknowns are visible to the reader, not silently dropped.
    expect(markdown).toContain('Cache: unknown');
  });

  it('carries no prompt, transcript, credential or private path into the rendering', () => {
    const secret = 'sk-live-PLANTED-SECRET';
    const privatePath = '/Users/someone/.local/state/private.json';
    const panorama = projectControlPanorama(facts({
      sessions: [session({ workspace: privatePath, externalId: 'provider-handle-9', acpSessionId: 'acp-secret' } as any)],
      results: [result({ summary: 'done' })],
      events: [obligation({ content: { summary: 'needs a call', evidenceRefs: [], contentHash: secret, sensitivity: 'normal', retention: 'standard' } })],
    }));
    const rendered = renderControlPanorama(panorama);

    for (const leak of [secret, privatePath, 'provider-handle-9', 'acp-secret']) {
      expect(JSON.stringify(panorama)).not.toContain(leak);
      expect(rendered).not.toContain(leak);
    }
  });
});
