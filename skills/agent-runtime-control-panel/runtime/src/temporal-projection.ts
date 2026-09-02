import type { ChannelEvent, Delivery, Goal, KnowledgeEntry, Member, Result, RuntimeSession, Task } from './arcp.js';
import { projectChannelEvent } from './channel-projection.js';

/** Read-only causal view. These are deliberately not durable state fields. */
export type TemporalDisposition = 'active' | 'resolved' | 'superseded' | 'invalidated' | 'expired_informational' | 'stale_requires_review';
export type TemporalFilter = 'active' | 'problems' | { taskId: string };
export type TemporalProblemReason = 'overdue' | 'stale' | 'superseded' | 'decision' | 'permission' | 'transport_uncertain' | 'duplicate' | 'completion_without_result' | 'generation_replaced' | 'steward_recursion' | 'delivery_generation_mismatch' | 'timestamp_nonmonotonic' | 'safe_point_invalid' | 'terminal_runtime_without_completion';

export interface TemporalProjectionFacts {
  channelEvents: readonly ChannelEvent[];
  deliveries: readonly Delivery[];
  tasks: readonly Task[];
  results: readonly Result[];
  sessions: readonly RuntimeSession[];
  members: readonly Member[];
  goals: readonly Goal[];
  knowledge: readonly KnowledgeEntry[];
  /** Injected by the caller: builders never read the clock. */
  nowMs?: number;
}
export interface TemporalCausation { causedBy?: string; supersedes?: string; resolvedBy?: string; replacement?: string; }
export interface TemporalCard {
  id: string;
  subject: { kind: 'task' | 'runtime' | 'workspace'; id: string; label: string };
  eventId?: string;
  eventTime: string;
  ageMs: number;
  sender: { label: string; role: string };
  stage?: string;
  headline: string;
  summary: string;
  transport: { state: string; queuedAt?: string; deliveredAt?: string; processedAt?: string; targetGeneration?: number; undeliverableReason?: string };
  disposition: TemporalDisposition;
  dispositionReason: string;
  causation: TemporalCausation;
  owner: string;
  nextAction: string;
  dueMs?: number;
  refs: { taskId?: string; resultId?: string; candidateSha?: string; knowledgeIds: string[] };
  problems: TemporalProblemReason[];
}
export interface TemporalProjection { filter: TemporalFilter; generatedAt: string; groups: Array<{ subject: TemporalCard['subject']; active?: TemporalCard; history: TemporalCard[] }>; cards: TemporalCard[]; problems: TemporalCard[]; reconciliation: Array<{ eventId: string; disposition: TemporalDisposition; reason: string; deterministic: boolean; nextAction: string }>; }

const BUDGET_MS = 60 * 60 * 1000;
const age = (at: string, now: number) => Math.max(0, now - Date.parse(at));
const eventRuntime = (event: ChannelEvent, deliveries: readonly Delivery[], sessions: readonly RuntimeSession[]) => {
  const delivery = deliveries.find((item) => item.eventId === event.id);
  return delivery ? sessions.find((item) => item.id === delivery.runtimeSessionId) : sessions.find((item) => item.memberId === event.sourceMemberId && (!event.taskId || item.taskId === event.taskId));
};
const reachable = (event: ChannelEvent, delivery: Delivery | undefined, sessions: readonly RuntimeSession[]) => {
  if (delivery) return sessions.some((session) => session.id === delivery.runtimeSessionId && session.generation === delivery.generation && !['terminal', 'transport_indeterminate'].includes(session.state));
  return sessions.some((session) => (event.targetMemberId ? session.memberId === event.targetMemberId : event.targetRole ? false : true) && !['terminal', 'transport_indeterminate'].includes(session.state));
};
const nonMonotonic = (delivery: Delivery | undefined) => {
  if (!delivery) return false;
  const timestamps = [delivery.createdAt, delivery.safePointObservedAt, delivery.attemptedAt, delivery.deliveredAt, delivery.processedAt, delivery.acknowledgedAt].filter((item): item is string => Boolean(item)).map(Date.parse);
  return timestamps.some((item, index) => index > 0 && item < timestamps[index - 1]);
};
const refs = (event: ChannelEvent) => ({ taskId: event.taskId, resultId: event.resultId, candidateSha: event.content.evidenceRefs.find((ref) => /^[0-9a-f]{7,40}$/i.test(ref)), knowledgeIds: event.content.evidenceRefs.filter((ref) => ref.startsWith('knowledge_')) });

/**
 * Computes semantic relevance independently from packet delivery. It never
 * alters events, deliveries, Tasks, or Results: callers may render it or use
 * reconciliation proposals, but a later Protect slice owns any append.
 */
export function projectTemporal(facts: TemporalProjectionFacts, filter: TemporalFilter = 'active'): TemporalProjection {
  // A deterministic fallback keeps direct/unit callers pure. Production callers
  // inject `nowMs`; no builder observes wall-clock time itself.
  const now = facts.nowMs ?? Math.max(0, ...facts.channelEvents.map((event) => Date.parse(event.createdAt)));
  const nowText = new Date(now).toISOString();
  const tasks = new Map(facts.tasks.map((item) => [item.id, item]));
  const members = new Map(facts.members.map((item) => [item.id, item]));
  const resultsByTask = new Map<string, Result[]>();
  for (const result of facts.results) resultsByTask.set(result.taskId, [...(resultsByTask.get(result.taskId) ?? []), result].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const cards: TemporalCard[] = facts.channelEvents.map((event) => {
    const channel = projectChannelEvent(event, facts);
    const task = event.taskId ? tasks.get(event.taskId) : undefined;
    const delivery = facts.deliveries.find((item) => item.eventId === event.id);
    const runtime = eventRuntime(event, facts.deliveries, facts.sessions);
    const senderMember = event.sourceMemberId ? members.get(event.sourceMemberId) : undefined;
    const results = task ? resultsByTask.get(task.id) ?? [] : [];
    const completion = results.find((result) => result.fence === task?.fence && result.status === 'candidate');
    const newerCandidate = results.filter((result) => result.fence === task?.fence && result.status === 'candidate' && result.createdAt > event.createdAt).at(-1);
    const replacement = runtime && facts.sessions.find((item) => item.id !== runtime.id && item.goalId === runtime.goalId && item.generation > runtime.generation);
    let disposition: TemporalDisposition = 'active'; let dispositionReason = 'No machine-provable semantic replacement or resolution.'; const causation: TemporalCausation = event.relatedEventId ? { causedBy: event.relatedEventId } : {};
    if (event.kind === 'decision_resolved') { disposition = 'resolved'; dispositionReason = 'Durable decision resolution is already recorded.'; if (event.relatedEventId) causation.resolvedBy = event.id; }
    else if (task?.lifecycle === 'completed' && completion && completion.createdAt <= task.updatedAt && ['decision_required', 'task_candidate'].includes(event.kind)) { disposition = 'superseded'; dispositionReason = 'Completed Task has a durable Result for this fence.'; causation.resolvedBy = completion.id; }
    else if (newerCandidate && ['decision_required', 'task_candidate'].includes(event.kind)) { disposition = 'superseded'; dispositionReason = 'A later Candidate for the same Task fence exists.'; causation.supersedes = newerCandidate.id; }
    else if ((replacement || runtime?.state === 'terminal') && ['runtime_health', 'permission', 'transport_uncertainty'].includes(event.kind)) { disposition = 'invalidated'; dispositionReason = replacement ? 'This runtime generation was replaced; its health/transport fact belongs only to the older episode.' : 'This runtime generation is terminal; its health/transport fact belongs only to that ended episode.'; causation.replacement = replacement?.id ?? runtime!.id; }
    else if (task?.lifecycle === 'completed' && ['decision_required', 'task_candidate'].includes(event.kind)) { disposition = 'stale_requires_review'; dispositionReason = 'Task is complete but no matching durable Result proves how this authority event was resolved.'; }
    const problems: TemporalProblemReason[] = [];
    const eventAge = age(event.createdAt, now);
    const targetReachable = reachable(event, delivery, facts.sessions);
    // Age is a budget signal only after a durable reachability contradiction;
    // it is never semantic staleness by itself.
    if (event.deliveryState === 'queued' && !targetReachable && !event.undeliverableReason && eventAge > BUDGET_MS) problems.push('overdue');
    if (event.deliveryState === 'delivered' && !event.processedAt && eventAge > BUDGET_MS) problems.push('overdue');
    if (event.deliveryState === 'transport_indeterminate' || event.kind === 'transport_uncertainty') problems.push('transport_uncertain');
    if (event.kind === 'permission') problems.push('permission');
    if (event.decisionRequired && disposition === 'active') problems.push('decision');
    if (disposition === 'stale_requires_review') problems.push('stale');
    if (disposition === 'superseded') problems.push('superseded');
    if (task?.scope === 'steward_analysis' || members.get(task?.ownerMemberId ?? '')?.role === 'steward-analyst') problems.push('steward_recursion');
    if (event.kind === 'task_completed' && !results.some((result) => result.createdAt <= event.createdAt)) problems.push('completion_without_result');
    if (replacement) problems.push('generation_replaced');
    if (delivery && runtime && delivery.generation !== runtime.generation) problems.push('delivery_generation_mismatch');
    if (nonMonotonic(delivery)) problems.push('timestamp_nonmonotonic');
    if (delivery?.state === 'waiting_safe_point' && (!runtime || runtime.state === 'idle' || runtime.state === 'terminal' || runtime.state === 'transport_indeterminate' || runtime.lastTurnState !== 'running') && eventAge > BUDGET_MS) problems.push('safe_point_invalid');
    // A Steward may report a supervision breach but must never become a
    // supervised subject itself. Keep the anomalous evidence at workspace scope.
    const stewardSubject = task?.scope === 'steward_analysis' || members.get(task?.ownerMemberId ?? '')?.role === 'steward-analyst';
    const subject = stewardSubject ? { kind: 'workspace' as const, id: event.workspaceId ?? 'workspace', label: 'Excluded Steward analysis' } : task ? { kind: 'task' as const, id: task.id, label: task.title } : runtime ? { kind: 'runtime' as const, id: `${runtime.id}:${runtime.generation}`, label: `${runtime.provider} generation ${runtime.generation}` } : { kind: 'workspace' as const, id: event.workspaceId ?? 'workspace', label: 'Workspace obligation' };
    const owner = event.targetRole ?? (event.targetMemberId ? members.get(event.targetMemberId)?.label ?? 'target member' : task?.ownerMemberId ? members.get(task.ownerMemberId)?.label ?? 'Task owner' : 'Manager/Deputy');
    const nextAction = disposition === 'active' ? (event.deliveryState === 'undeliverable' || event.deliveryState === 'transport_indeterminate' ? 'Deliver to a current reachable target; transport failure does not close this obligation.' : event.decisionRequired ? 'Current owner must record one semantic disposition.' : 'Continue the current obligation.') : disposition === 'stale_requires_review' ? 'Manager or Deputy must review and append a disposition in a later protected slice.' : 'Keep as causal history; no delivery-state rewrite is proposed.';
    return { id: event.id, subject, eventId: event.id, eventTime: event.createdAt, ageMs: eventAge, sender: channel.sender, ...(channel.stage ? { stage: channel.stage } : {}), headline: channel.headline, summary: channel.summary.join(' '), transport: { state: event.deliveryState, queuedAt: event.createdAt, ...(event.deliveredAt ? { deliveredAt: event.deliveredAt } : {}), ...(event.processedAt ? { processedAt: event.processedAt } : {}), ...(delivery ? { targetGeneration: delivery.generation } : {}), ...(event.undeliverableReason ? { undeliverableReason: event.undeliverableReason } : {}) }, disposition, dispositionReason, causation, owner, nextAction, ...(problems.includes('overdue') ? { dueMs: BUDGET_MS } : {}), refs: refs(event), problems };
  });
  // A terminal Runtime is transport history, never Task completion.  When its
  // unowned ready Task has no durable Result, the causal gap is ambiguous: show
  // it as Manager-owned review debt instead of inventing a completion or a
  // deterministic disposition for an event that does not exist.
  for (const runtime of facts.sessions.filter((item) => item.state === 'terminal' && item.taskId)) {
    const task = tasks.get(runtime.taskId!);
    if (!task || task.lifecycle !== 'ready' || task.ownerMemberId || (resultsByTask.get(task.id) ?? []).length) continue;
    cards.push({
      id: `temporal:${task.id}:${runtime.id}`,
      subject: { kind: 'task', id: task.id, label: task.title },
      eventTime: runtime.lastObservedAt ?? runtime.createdAt,
      ageMs: age(runtime.lastObservedAt ?? runtime.createdAt, now),
      sender: { label: 'ARCP temporal projection', role: 'system' },
      headline: 'Terminal runtime left a ready Task without a durable Result',
      summary: 'The Runtime ended, but its Task remains ready and unowned. Process exit is transport history, not Task completion.',
      transport: { state: runtime.state, targetGeneration: runtime.generation },
      disposition: 'stale_requires_review',
      dispositionReason: 'A terminal Runtime and ready unowned Task do not prove whether work should be resumed, reassigned, or retired.',
      causation: { causedBy: runtime.id },
      owner: 'Manager/Deputy',
      nextAction: 'Manager must decide whether to relaunch, reassign, or explicitly close the Task; do not infer completion from Runtime termination.',
      refs: { taskId: task.id, knowledgeIds: [] },
      problems: ['stale', 'terminal_runtime_without_completion'],
    });
  }
  // Invariant 2: a task fence has one canonical completion. Later completions
  // are duplicate evidence; they never introduce another transition.
  const completed = new Map<string, TemporalCard[]>();
  for (const card of cards.filter((card) => facts.channelEvents.find((event) => event.id === card.eventId)?.kind === 'task_completed' && card.refs.taskId)) {
    const result = facts.results.find((item) => item.id === card.refs.resultId);
    const task = tasks.get(card.refs.taskId!); const key = `${card.refs.taskId}:${result?.fence ?? task?.fence ?? 0}`;
    completed.set(key, [...(completed.get(key) ?? []), card]);
  }
  for (const duplicates of completed.values()) for (const card of duplicates.sort((a, b) => a.eventTime.localeCompare(b.eventTime)).slice(1)) { card.problems.push('duplicate'); card.disposition = 'superseded'; card.dispositionReason = 'Repeated task completion for the same Task fence is duplicate evidence, not a new transition.'; card.causation.supersedes = duplicates[0].id; }
  // Rule 4: same sourceId is one semantic Result. Mark all but the earliest
  // corresponding candidate cards as duplicate evidence, never extra work.
  for (const result of facts.results.filter((item) => item.sourceId)) {
    const duplicate = facts.results.filter((item) => item.sourceId === result.sourceId && item.id !== result.id);
    if (duplicate.length) for (const card of cards.filter((item) => item.refs.resultId === result.id || item.refs.taskId === result.taskId && item.refs.candidateSha && item.eventTime >= result.createdAt)) if (!card.problems.includes('duplicate')) { card.problems.push('duplicate'); if (card.disposition === 'active') { card.disposition = 'superseded'; card.dispositionReason = 'Duplicate source identity is semantic retry evidence, not a new obligation.'; card.causation.supersedes = duplicate[0].id; } }
  }
  const reconciliation = cards.filter((card) => card.disposition !== 'active').map((card) => ({ eventId: card.id, disposition: card.disposition, reason: card.dispositionReason, deterministic: card.disposition !== 'stale_requires_review', nextAction: card.nextAction }));
  const selected = filter === 'problems' ? cards.filter((card) => card.problems.length > 0) : typeof filter === 'object' ? cards.filter((card) => card.refs.taskId === filter.taskId) : cards.filter((card) => card.disposition === 'active');
  const grouped = new Map<string, { subject: TemporalCard['subject']; active?: TemporalCard; history: TemporalCard[] }>();
  for (const card of selected) { const group = grouped.get(`${card.subject.kind}:${card.subject.id}`) ?? { subject: card.subject, history: [] }; if (card.disposition === 'active' && !group.active) group.active = card; else group.history.push(card); grouped.set(`${card.subject.kind}:${card.subject.id}`, group); }
  return { filter, generatedAt: nowText, groups: [...grouped.values()], cards: selected, problems: cards.filter((card) => card.problems.length > 0), reconciliation };
}

export const temporalReconciliationPreview = (facts: TemporalProjectionFacts) => projectTemporal(facts).reconciliation;
