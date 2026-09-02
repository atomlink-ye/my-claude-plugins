import type { ChannelEvent, Delivery, Goal, KnowledgeEntry, Member, Result, RuntimeSession, Task } from './arcp.js';

/** Read-only causal view. These are deliberately not durable state fields. */
export type TemporalDisposition = 'active' | 'resolved' | 'superseded' | 'invalidated' | 'expired_informational' | 'stale_requires_review';
export type TemporalFilter = 'active' | 'problems' | { taskId: string };
export type TemporalProblemReason = 'overdue' | 'stale' | 'superseded' | 'decision' | 'permission' | 'transport_uncertain' | 'duplicate' | 'completion_without_result' | 'generation_replaced' | 'steward_recursion';

export interface TemporalProjectionFacts {
  channelEvents: readonly ChannelEvent[];
  deliveries: readonly Delivery[];
  tasks: readonly Task[];
  results: readonly Result[];
  sessions: readonly RuntimeSession[];
  members: readonly Member[];
  goals: readonly Goal[];
  knowledge: readonly KnowledgeEntry[];
  now?: string;
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
const stage = (text: string) => text.match(/\b(?:R(?:ound)?[- ]?)(\d)(?:[- ·:]*(?:lane )?([A-Z]))?/i)?.slice(1).filter(Boolean).map((v, i) => i ? `Lane ${v.toUpperCase()}` : `Round-${v}`).join(' ');
const age = (at: string, now: number) => Math.max(0, now - Date.parse(at));
const short = (text: string, max = 160) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const eventRuntime = (event: ChannelEvent, deliveries: readonly Delivery[], sessions: readonly RuntimeSession[]) => {
  const delivery = deliveries.find((item) => item.eventId === event.id);
  return delivery ? sessions.find((item) => item.id === delivery.runtimeSessionId) : undefined;
};
const refs = (event: ChannelEvent) => ({ taskId: event.taskId, resultId: event.resultId, candidateSha: event.content.evidenceRefs.find((ref) => /^[0-9a-f]{7,40}$/i.test(ref)), knowledgeIds: event.content.evidenceRefs.filter((ref) => ref.startsWith('knowledge_')) });

/**
 * Computes semantic relevance independently from packet delivery. It never
 * alters events, deliveries, Tasks, or Results: callers may render it or use
 * reconciliation proposals, but a later Protect slice owns any append.
 */
export function projectTemporal(facts: TemporalProjectionFacts, filter: TemporalFilter = 'active'): TemporalProjection {
  const nowText = facts.now ?? new Date().toISOString(); const now = Date.parse(nowText);
  const tasks = new Map(facts.tasks.map((item) => [item.id, item]));
  const members = new Map(facts.members.map((item) => [item.id, item]));
  const resultsByTask = new Map<string, Result[]>();
  for (const result of facts.results) resultsByTask.set(result.taskId, [...(resultsByTask.get(result.taskId) ?? []), result].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const cards: TemporalCard[] = facts.channelEvents.map((event) => {
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
    else if (replacement && ['runtime_health', 'permission', 'transport_uncertainty'].includes(event.kind)) { disposition = 'invalidated'; dispositionReason = 'This runtime generation was replaced; its health/transport fact belongs only to the older episode.'; causation.replacement = replacement.id; }
    else if (task?.lifecycle === 'completed' && ['decision_required', 'task_candidate'].includes(event.kind)) { disposition = 'stale_requires_review'; dispositionReason = 'Task is complete but no matching durable Result proves how this authority event was resolved.'; }
    const problems: TemporalProblemReason[] = [];
    const eventAge = age(event.createdAt, now);
    if ((event.deliveryState === 'queued' || delivery?.state === 'waiting_safe_point') && eventAge > BUDGET_MS) problems.push('overdue');
    if (event.deliveryState === 'delivered' && !event.processedAt && eventAge > BUDGET_MS) problems.push('overdue');
    if (event.deliveryState === 'transport_indeterminate' || event.kind === 'transport_uncertainty') problems.push('transport_uncertain');
    if (event.kind === 'permission') problems.push('permission');
    if (event.decisionRequired && disposition === 'active') problems.push('decision');
    if (disposition === 'stale_requires_review') problems.push('stale');
    if (disposition === 'superseded') problems.push('superseded');
    if (task?.scope === 'steward_analysis' || members.get(task?.ownerMemberId ?? '')?.role === 'steward-analyst') problems.push('steward_recursion');
    if (event.kind === 'task_completed' && !results.some((result) => result.createdAt <= event.createdAt)) problems.push('completion_without_result');
    if (replacement) problems.push('generation_replaced');
    const subject = task ? { kind: 'task' as const, id: task.id, label: task.title } : runtime ? { kind: 'runtime' as const, id: `${runtime.id}:${runtime.generation}`, label: `${runtime.provider} generation ${runtime.generation}` } : { kind: 'workspace' as const, id: event.workspaceId ?? 'workspace', label: 'Workspace obligation' };
    const owner = event.targetRole ?? (event.targetMemberId ? members.get(event.targetMemberId)?.label ?? 'target member' : task?.ownerMemberId ? members.get(task.ownerMemberId)?.label ?? 'Task owner' : 'Manager/Deputy');
    const nextAction = disposition === 'active' ? (event.deliveryState === 'undeliverable' || event.deliveryState === 'transport_indeterminate' ? 'Deliver to a current reachable target; transport failure does not close this obligation.' : event.decisionRequired ? 'Current owner must record one semantic disposition.' : 'Continue the current obligation.') : disposition === 'stale_requires_review' ? 'Manager or Deputy must review and append a disposition in a later protected slice.' : 'Keep as causal history; no delivery-state rewrite is proposed.';
    return { id: event.id, subject, eventId: event.id, eventTime: event.createdAt, ageMs: eventAge, sender: { label: senderMember?.label ?? 'unattributed', role: senderMember?.role ?? 'unknown' }, ...(stage(task?.title ?? event.content.summary) ? { stage: stage(task?.title ?? event.content.summary) } : {}), headline: short(event.content.summary), summary: short(event.content.summary, 480), transport: { state: event.deliveryState, queuedAt: event.createdAt, ...(event.deliveredAt ? { deliveredAt: event.deliveredAt } : {}), ...(event.processedAt ? { processedAt: event.processedAt } : {}), ...(delivery ? { targetGeneration: delivery.generation } : {}), ...(event.undeliverableReason ? { undeliverableReason: event.undeliverableReason } : {}) }, disposition, dispositionReason, causation, owner, nextAction, ...(problems.includes('overdue') ? { dueMs: BUDGET_MS } : {}), refs: refs(event), problems };
  });
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

export const temporalReconciliationPreview = (facts: TemporalProjectionFacts) => projectTemporal(facts, 'active').reconciliation;
