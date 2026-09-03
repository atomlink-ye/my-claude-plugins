import type { ChannelEvent, Delivery, Goal, KnowledgeEntry, Member, Result, RuntimeSession, Task } from './arcp.js';
import type { ExecutionSurface, SurfaceClaim } from './execution-placement.js';
import { compareSequenceEntries, missingSequenceFacts, sequenceRankOf, type ReportingRoute, type SequenceEntry, type SequenceEntryKind, type SequenceFacts, type SequenceProjection, type SequenceRef } from './sequence-model.js';

type Fact = string | number | boolean;
const validAt = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? value : undefined;
const ref = (kind: SequenceRef['kind'], id: string, label?: string): SequenceRef => ({ kind, id, ...(label ? { label } : {}) });
const actor = (memberId: string | undefined, members: ReadonlyMap<string, Member>) => {
  const member = memberId ? members.get(memberId) : undefined;
  return member ? { memberId: member.id, label: member.label, role: member.role } : undefined;
};
const subjectFor = (taskId: string | undefined, runtimeId: string | undefined, workspaceId: string | undefined, tasks: ReadonlyMap<string, Task>, sessions: ReadonlyMap<string, RuntimeSession>): SequenceRef => {
  const task = taskId ? tasks.get(taskId) : undefined;
  if (task) return ref('task', task.id, task.title);
  const session = runtimeId ? sessions.get(runtimeId) : undefined;
  if (session) return ref('runtime', session.id, `${session.provider} generation ${session.generation}`);
  return ref('workspace', workspaceId ?? 'workspace');
};

/** Pure fold of durable ARCP facts.  This module never reads the clock or writes state. */
export function projectSequence(facts: SequenceFacts): SequenceProjection {
  const scoped = <T extends { workspaceId?: string }>(items: readonly T[]) => facts.workspaceId ? items.filter((item) => item.workspaceId === facts.workspaceId) : items;
  const members = new Map(scoped(facts.members).map((item) => [item.id, item]));
  const tasks = new Map(scoped(facts.tasks).map((item) => [item.id, item]));
  const sessions = new Map(scoped(facts.sessions).map((item) => [item.id, item]));
  const goalForTask = new Map(scoped(facts.sessions).filter((item) => item.taskId).map((item) => [item.taskId!, item.goalId]));
  const entries: SequenceEntry[] = [];
  // A scoped view fails closed: a record without a direct or proven indirect
  // workspace owner cannot be shown in another workspace's narrative.
  const include = (workspaceId: string | undefined) => !facts.workspaceId || workspaceId === facts.workspaceId;
  const add = (id: string, at: string | undefined, kind: SequenceEntryKind, subject: SequenceRef, headline: string, factsMap: Record<string, Fact>, input: Partial<SequenceEntry> = {}) => {
    const stamp = validAt(at);
    if (!stamp) return;
    entries.push({ id, at: stamp, atMs: Date.parse(stamp), tiebreak: { rank: sequenceRankOf(kind), key: id }, kind, subject, headline, summary: headline, refs: [], causal: [], facts: factsMap, ...input });
  };
  for (const goal of facts.goals.filter((item) => include(item.workspaceId))) {
    const subject = ref('goal', goal.id, goal.title);
    add(`goal:${goal.id}:started`, goal.createdAt, 'goal_started', subject, `Goal started: ${goal.title}`, { goalId: goal.id, title: goal.title }, { actor: { label: goal.actorId, role: 'actor' }, refs: [ref('workspace', goal.workspaceId ?? facts.workspaceId ?? 'workspace')] });
    if (goal.updatedAt !== goal.createdAt) add(`goal:${goal.id}:state`, goal.updatedAt, 'goal_state_changed', subject, `Goal ${goal.state}`, { goalId: goal.id, state: goal.state }, { causal: [{ kind: 'caused_by', entryId: `goal:${goal.id}:started` }] });
  }
  for (const task of facts.tasks.filter((item) => include(item.workspaceId))) {
    const subject = ref('task', task.id, task.title);
    add(`task:${task.id}:created`, task.createdAt, 'task_created', subject, `Task created: ${task.title}`, { taskId: task.id, fence: task.fence }, { refs: [ref('workspace', task.workspaceId)] });
    // Task snapshots carry no separate claim timestamp.  A claim is emitted
    // only from the append-only channel record below, never manufactured from
    // current ownership.
    if (task.updatedAt !== task.createdAt) add(`task:${task.id}:lifecycle`, task.updatedAt, 'task_lifecycle_changed', subject, `Task ${task.lifecycle}`, { taskId: task.id, lifecycle: task.lifecycle }, { causal: [{ kind: 'caused_by', entryId: `task:${task.id}:created` }] });
  }
  for (const session of facts.sessions.filter((item) => include(item.workspaceId))) {
    const subject = ref('runtime', session.id, `${session.provider} generation ${session.generation}`);
    add(`runtime:${session.id}:launched`, session.createdAt, 'runtime_launched', subject, `Runtime launched: ${session.provider}`, { runtimeId: session.id, lineageId: session.bindingId, generation: session.generation, provider: session.provider, hasContract: Boolean(session.contractBoundAtLaunch) }, { actor: actor(session.memberId, members), refs: [ref('goal', session.goalId), ...(session.taskId ? [ref('task', session.taskId)] : [])] });
    if (session.contractBoundAtLaunch) add(`runtime:${session.id}:contract-bound`, session.createdAt, 'goal_contract_bound', ref('goal', session.goalId), 'Goal Contract bound at launch', { goalId: session.goalId, boundAtLaunch: true }, { refs: [ref('runtime', session.id), ...(session.taskId ? [ref('task', session.taskId)] : [])], causal: [{ kind: 'caused_by', entryId: `runtime:${session.id}:launched` }] });
    if (session.lastObservedAt) add(`runtime:${session.id}:observed`, session.lastObservedAt, session.state === 'terminal' ? 'runtime_terminal' : 'runtime_observed', subject, `Runtime ${session.state}`, session.state === 'terminal' ? { runtimeId: session.id, lineageId: session.bindingId, generation: session.generation } : { runtimeId: session.id, lineageId: session.bindingId, generation: session.generation, state: session.state }, { causal: [{ kind: 'caused_by', entryId: `runtime:${session.id}:launched` }] });
    const previousGeneration = [...sessions.values()].filter((other) => other.id !== session.id && other.goalId === session.goalId && other.bindingId === session.bindingId && other.generation < session.generation).sort((a, b) => b.generation - a.generation)[0];
    if (previousGeneration) add(`runtime:${session.id}:generation`, session.createdAt, 'runtime_generation_changed', subject, `Runtime generation ${session.generation}`, { runtimeId: session.id, lineageId: session.bindingId, generation: session.generation }, { causal: [{ kind: 'replaces', entryId: `runtime:${previousGeneration.id}:launched` }] });
  }
  const deliveryKind: Record<string, SequenceEntryKind> = { queued: 'delivery_queued', held: 'delivery_queued', waiting_safe_point: 'delivery_safe_point', attempting: 'delivery_attempted', delivered: 'delivery_delivered', running: 'delivery_delivered', processed: 'delivery_processed', acknowledged: 'delivery_acknowledged', withdrawn: 'delivery_withdrawn', transport_indeterminate: 'delivery_undeliverable' };
  for (const delivery of facts.deliveries) {
    const session = sessions.get(delivery.runtimeSessionId); if (!session || !include(session.workspaceId)) continue;
    const subject = subjectFor(delivery.subject?.taskId, delivery.runtimeSessionId, session.workspaceId, tasks, sessions);
    const base = { deliveryId: delivery.id, lineageId: session.bindingId, purpose: delivery.purpose ?? 'message', targetGeneration: delivery.generation };
    const milestones: Array<[SequenceEntryKind, string | undefined]> = [['delivery_queued', delivery.createdAt], ['delivery_safe_point', delivery.safePointObservedAt], ['delivery_attempted', delivery.attemptedAt], ['delivery_delivered', delivery.deliveredAt], ['delivery_processed', delivery.processedAt], ['delivery_acknowledged', delivery.acknowledgedAt]];
    if (delivery.state === 'withdrawn') milestones.push(['delivery_withdrawn', delivery.acknowledgedAt ?? delivery.processedAt ?? delivery.createdAt]);
    if (delivery.state === 'transport_indeterminate') milestones.push(['delivery_undeliverable', delivery.attemptedAt ?? delivery.createdAt]);
    let previous = `runtime:${delivery.runtimeSessionId}:launched`;
    for (const [kind, at] of milestones) { if (!at) continue; const id = `delivery:${delivery.id}:${kind}`; add(id, at, kind, subject, `Delivery ${kind.replace('delivery_', '')}`, kind === 'delivery_undeliverable' ? { ...base, undeliverableReason: delivery.refusedReason ?? 'transport_indeterminate' } : base, { refs: [ref('delivery', delivery.id), ref('runtime', delivery.runtimeSessionId), ...(delivery.eventId ? [ref('event', delivery.eventId)] : [])], causal: [{ kind: 'caused_by', entryId: previous }] }); previous = id; }
    // A Contract delivered outside the launch reached the runtime only because
    // it survived every fail-closed re-check; that is a real, non-atomic bind,
    // never the atomic one, so it always folds with `boundAtLaunch: false`.
    if (delivery.purpose === 'contract' && delivery.deliveredAt) { const goalId = delivery.subject?.taskId ? goalForTask.get(delivery.subject.taskId) : undefined; if (goalId) add(`delivery:${delivery.id}:contract-bound`, delivery.deliveredAt, 'goal_contract_bound', ref('goal', goalId), 'Goal Contract bound by late Delivery', { goalId, boundAtLaunch: false }, { refs: [ref('delivery', delivery.id), ref('runtime', delivery.runtimeSessionId)], causal: [{ kind: 'caused_by', entryId: `delivery:${delivery.id}:delivery_delivered` }] }); }
  }
  for (const event of facts.channelEvents.filter((item) => include(item.workspaceId))) {
    const subject = subjectFor(event.taskId, undefined, event.workspaceId, tasks, sessions);
    const transitions = (event.transitions.length ? event.transitions : [{ state: 'queued' as const, at: event.createdAt }]).slice().sort((a, b) => a.at.localeCompare(b.at) || a.state.localeCompare(b.state)); let previous = event.relatedEventId ? `event:${event.relatedEventId}:transition:queued:${event.createdAt}` : undefined;
    for (const transition of transitions) { const id = `event:${event.id}:transition:${transition.state}:${transition.at}`; const claimed = event.kind === 'task_claimed' && event.taskId && tasks.get(event.taskId) && event.sourceMemberId; const kind: SequenceEntryKind = claimed ? 'task_claimed' : 'channel_event'; let eventFacts: Record<string, Fact>; if (claimed) eventFacts = { taskId: event.taskId!, fence: tasks.get(event.taskId!)!.fence, memberId: event.sourceMemberId! }; else eventFacts = { eventId: event.id, kind: event.kind, deliveryState: transition.state }; add(id, transition.at, kind, subject, `${event.content.summary} (${transition.state})`, eventFacts, { actor: actor(event.sourceMemberId, members), refs: [ref('event', event.id), ...(event.resultId ? [ref('result', event.resultId)] : [])], causal: previous ? [{ kind: 'caused_by', entryId: previous }] : [] }); if (claimed && tasks.get(event.taskId!)!.fence > 0) add(`task:${event.taskId}:fence:${tasks.get(event.taskId!)!.fence}:${transition.at}`, transition.at, 'task_fence_advanced', subject, `Task fence ${tasks.get(event.taskId!)!.fence}`, { taskId: event.taskId!, fence: tasks.get(event.taskId!)!.fence }, { causal: [{ kind: 'caused_by', entryId: id }] }); previous = id; }
    for (const disposition of event.dispositions) add(`receipt:${disposition.id}`, disposition.at, 'receipt', subject, `Event ${disposition.kind} receipt`, { eventId: event.id, receiptId: disposition.id, disposition: disposition.kind }, { actor: actor(disposition.actorMemberId, members), causal: [{ kind: 'acknowledges', entryId: previous! }] });
    if (event.verdict) add(`event:${event.id}:verdict`, event.resolvedAt ?? event.createdAt, 'verdict_recorded', subject, `Decision ${event.verdict}`, { eventId: event.id, verdict: event.verdict }, { causal: [{ kind: 'caused_by', entryId: previous! }] });
  }
  for (const result of facts.results.filter((item) => include(item.workspaceId))) {
    const task = tasks.get(result.taskId); const subject = task ? ref('task', task.id, task.title) : ref('task', result.taskId);
    const goalId = goalForTask.get(result.taskId);
    add(`result:${result.id}`, result.createdAt, 'result_submitted', subject, `Result ${result.status}`, { resultId: result.id, taskId: result.taskId, fence: result.fence, memberId: result.memberId, status: result.status }, { actor: actor(result.memberId, members), refs: [ref('result', result.id), ref('task', result.taskId), ...(goalId ? [ref('goal', goalId)] : [])] });
  }
  for (const knowledge of facts.knowledge.filter((item) => include(item.workspaceId))) add(`knowledge:${knowledge.id}`, knowledge.createdAt, 'knowledge_recorded', subjectFor(knowledge.taskId, undefined, knowledge.workspaceId, tasks, sessions), `Knowledge: ${knowledge.kind}`, { knowledgeId: knowledge.id, kind: knowledge.kind }, { actor: actor(knowledge.authorMemberId, members), refs: [ref('knowledge', knowledge.id), ...(knowledge.goalId ? [ref('goal', knowledge.goalId)] : [])] });
  const scopedRuntimeIds = new Set(facts.sessions.filter((session) => include(session.workspaceId)).map((session) => session.id));
  for (const surface of facts.executionSurfaces.filter((surface) => !facts.workspaceId || facts.surfaceClaims.some((claim) => claim.executionSurfaceId === surface.id && scopedRuntimeIds.has(claim.runtimeSessionId)))) {
    const subject = ref('surface', surface.id); if (surface.visibilityState === 'archived') add(`surface:${surface.id}:archived`, surface.updatedAt, 'surface_archived', subject, 'Surface archived', { surfaceId: surface.id });
  }
  for (const claim of facts.surfaceClaims) {
    const surface = facts.executionSurfaces.find((item) => item.id === claim.executionSurfaceId); if (!surface || !scopedRuntimeIds.has(claim.runtimeSessionId)) continue;
    const subject = ref('surface', surface.id); const kind = claim.active ? 'surface_claimed' : 'surface_released';
    add(`claim:${claim.id}:${kind}`, claim.releasedAt ?? claim.createdAt, kind, subject, claim.active ? 'Surface claimed' : 'Surface released', { surfaceId: surface.id, claimId: claim.id, runtimeSessionId: claim.runtimeSessionId, active: claim.active }, { refs: [ref('runtime', claim.runtimeSessionId)] });
  }
  for (const route of facts.reportingRoutes.filter((item) => include(item.workspaceId))) {
    const subject = ref(route.subject.kind, route.subject.id); const routeFacts = { routeId: route.id, launchedByMemberId: route.launchedByMemberId, ackPolicy: route.ackPolicy };
    add(`route:${route.id}:declared`, route.createdAt, 'route_declared', subject, 'Reporting route declared', routeFacts, { refs: [ref('route', route.id)] });
    const endpoints = [{ role: 'primary' as const, recipient: route.primaryHandler, obligation: 'owned' as const }, ...route.ccRecipients.map((recipient) => ({ role: 'cc' as const, recipient, obligation: 'observe_only' as const }))];
    for (const endpoint of endpoints) add(`route:${route.id}:fanout:${endpoint.role}:${endpoint.recipient.memberId ?? endpoint.recipient.role ?? 'recipient'}`, route.createdAt, 'route_fanout', subject, `Route ${endpoint.role} recipient`, { routeId: route.id, obligation: endpoint.obligation }, { route: { routeId: route.id, ...endpoint }, causal: [{ kind: 'fans_out_from', entryId: `route:${route.id}:declared` }] });
    let previous = `route:${route.id}:declared`;
    for (const transition of route.transitions) { if (transition.kind === 'closed') continue; const kind = transition.kind === 'acknowledged' ? 'route_acknowledged' : transition.kind === 'primary_changed' ? 'route_handler_changed' : transition.kind === 'escalated' ? 'route_escalated' : 'route_declared'; const id = `route:${route.id}:transition:${transition.id}`; add(id, transition.at, kind, subject, `Route ${transition.kind}`, { routeId: route.id, ...(kind === 'route_declared' ? { launchedByMemberId: route.launchedByMemberId, ackPolicy: route.ackPolicy } : {}) }, { causal: [{ kind: transition.kind === 'escalated' ? 'escalates' : 'caused_by', entryId: previous }] }); previous = id; }
  }
  entries.sort(compareSequenceEntries);
  for (const entry of entries) {
    const missing = missingSequenceFacts(entry);
    if (missing.length) throw new Error(`Sequence entry ${entry.id} is missing required facts: ${missing.join(', ')}`);
  }
  const timelines = new Map<string, { subject: SequenceRef; entryIds: string[] }>();
  for (const entry of entries) { const key = `${entry.subject.kind}:${entry.subject.id}`; const timeline = timelines.get(key) ?? { subject: entry.subject, entryIds: [] }; timeline.entryIds.push(entry.id); timelines.set(key, timeline); }
  const now = facts.nowMs ?? Math.max(0, ...entries.map((entry) => entry.atMs));
  return { schemaVersion: 'arcp.sequence/v1', generatedAt: new Date(now).toISOString(), entries, timelines: [...timelines.values()] };
}
