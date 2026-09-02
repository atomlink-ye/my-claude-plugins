import type { ChannelEvent } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

export const WORKSPACE = 'workspace_a3eef982-afab-47ac-b286-9749a3cce343';
export const OWNER_MEMBER = 'member_287ac3ec-9649-4cee-8a7a-f750a0ce0b75';
export const LANE_C_KNOWLEDGE = 'knowledge_308365c2-c1e4-46e5-a2e3-7ff89db32d9b';

/** Redacted durable facts for the Lane C channel rendering regression. */
export const laneCFacts = () => ({
  members: [
    { id: OWNER_MEMBER, workspaceId: WORKSPACE, actorId: 'actor_689a470de46a647be6aa', joinKind: 'native' as const, label: 'Hermes Owner Deputy', role: 'owner', capabilities: ['write_knowledge'], lifecycle: 'busy' as const, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T22:10:03.812Z' },
    { id: 'member_worker', workspaceId: WORKSPACE, joinKind: 'native' as const, label: 'Codex Worker', role: 'worker', capabilities: [], lifecycle: 'busy' as const, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T13:01:54.413Z' },
  ],
  tasks: [],
  goals: [],
  results: [],
  knowledge: [{
    id: LANE_C_KNOWLEDGE, workspaceId: WORKSPACE, authorMemberId: OWNER_MEMBER, kind: 'evidence' as const, tags: [], createdAt: '2026-09-01T21:50:05.691Z',
    text: 'R3-LANE-C C1 LANDED at 2acda1f on feat/agent-runtime-control-panel: R2-REV-F17 is closed. Lanes A and B may rebase onto this now. WHAT CHANGED in arcp.ts decision semantics. resolveDecision(eventId, sourceMemberId, summary, verdict) takes a fourth argument, type DecisionVerdict = accept | refuse, defaulting to accept so every existing caller keeps its current meaning. Only accept completes the Task; a refuse clears decisionRequired, records the verdict, and deliberately leaves the Task lifecycle untouched so refused work stays open. An unrecognised verdict throws invalid_request with field verdict before any state is touched. ChannelEvent gains an optional verdict field carried on both the decision_required event and its linked decision_resolved reply. RuntimeSession gains blockedOnEventId, blockedSince and blockedQuestion. HTTP POST /v1/events/:id/resolve accepts verdict in the body, default accept.',
  }],
});

// This is a redacted historical envelope, so it intentionally omits derived
// delivery fields that the projection supplies when it reads durable state.
export const laneCEvent = (): ChannelEvent => ({
  id: 'event_5eeeb49b421fb2596be4', workspaceId: WORKSPACE, sourceMemberId: OWNER_MEMBER, targetRole: 'manager',
  kind: 'finding', urgency: 'normal', decisionRequired: false,
  content: { summary: `evidence knowledge ${LANE_C_KNOWLEDGE}`, evidenceRefs: [], contentHash: 'e2a47ae3', sensitivity: 'normal', retention: 'standard' },
  deliveryState: 'processed', transitions: [{ state: 'queued', at: '2026-09-01T21:50:05.694Z' }, { state: 'processed', at: '2026-09-01T21:52:07.247Z' }],
  createdAt: '2026-09-01T21:50:05.694Z',
} as unknown as ChannelEvent);
