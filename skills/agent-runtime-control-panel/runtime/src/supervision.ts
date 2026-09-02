import { createHash } from 'node:crypto';

/**
 * Supervision budgets: one deep evaluation module behind a small interface.
 *
 * The module answers exactly two questions and owns both answers:
 *   1. when did a supervised subject last make MATERIAL progress, and
 *   2. which subjects have breached a budget and are not already under review.
 *
 * It is deliberately not a scheduler and not a policy engine. It has no timer,
 * no I/O and no clock of its own: the caller supplies `now`, so every decision
 * is a pure function of durable facts plus one number.
 */

export type SupervisionSubjectKind = 'task';
export type SupervisionReason = 'review_budget' | 'inactivity_budget';
export type SupervisionSignalKind = 'commit' | 'runtime_observation';

/** The owner-configured budget for one Workspace. One policy per Workspace. */
export interface SupervisionPolicy {
  id: string;
  workspaceId: string;
  /** Wall-clock age of the subject that requires a review, regardless of progress. */
  reviewAfterMs?: number;
  /** Duration since the last material progress that requires a review. */
  inactivityAfterMs?: number;
  cooldownMs: number;
  stewardProfileId: string;
  automatic: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Durable evidence that arrives from outside the ARCP record set: a commit, or
 * a runtime observation. `digest` is what makes the evidence material — a
 * repeated identical digest is a keepalive and never advances the clock.
 */
export interface SupervisionSignal {
  id: string;
  workspaceId: string;
  subjectId: string;
  kind: SupervisionSignalKind;
  digest: string;
  observedAt: string;
}

/** The durable record a breach creates. It is a review subject, never a kill. */
export interface SupervisionReview {
  id: string;
  workspaceId: string;
  policyId: string;
  subjectKind: SupervisionSubjectKind;
  subjectId: string;
  /** The subject generation (task fence) the breach was observed against. */
  generation: number;
  reason: SupervisionReason;
  eventId: string;
  breachedAt: string;
  lastProgressAt: string;
  cooldownUntil: string;
  state: 'open' | 'acknowledged';
  acknowledgedAt?: string;
  acknowledgedByMemberId?: string;
}

export interface SupervisedSubject {
  id: string;
  workspaceId: string;
  generation: number;
  lifecycle: string;
  createdAt: string;
  updatedAt: string;
  /** Role-keyed exclusion for ephemeral Steward bookkeeping Tasks. */
  ownerRole?: string;
  /** Durable, claim-independent exclusion for Steward analysis Tasks. */
  scope?: 'product' | 'steward_analysis';
}

export interface SupervisionView {
  subjects: SupervisedSubject[];
  results: Array<{ taskId?: string; createdAt: string }>;
  knowledge: Array<{ taskId?: string; createdAt: string }>;
  events: Array<{ taskId?: string; kind: string; createdAt: string }>;
  signals: SupervisionSignal[];
  policies: SupervisionPolicy[];
  reviews: SupervisionReview[];
}

export interface SupervisionBreach {
  reviewId: string;
  eventId: string;
  policyId: string;
  workspaceId: string;
  subjectKind: SupervisionSubjectKind;
  subjectId: string;
  generation: number;
  reason: SupervisionReason;
  breachedAt: string;
  lastProgressAt: string;
  cooldownUntil: string;
}

export interface MaterialProgress {
  at: string;
  source: 'subject_created' | 'state_change' | 'result' | 'knowledge' | 'event' | 'commit' | 'runtime_observation';
}

/** Lifecycles that a supervision budget applies to. A proposed or finished
 * Task has nothing to supervise, and supervising one would breach forever. */
export const SUPERVISED_LIFECYCLES = new Set(['claimed', 'running', 'waiting']);

/**
 * ChannelEvent kinds that constitute material progress.
 *
 * Membership is the load-bearing decision of this module. Every kind here is
 * produced by a DURABLE state change: a claim, a Result, a Knowledge write, a
 * decision, or a completed phase. A budget computed from anything else fires on
 * a working agent and stays silent on a stalled one.
 */
export const DURABLE_PROGRESS_EVENT_KINDS = new Set([
  'task_claimed',
  'task_candidate',
  'task_completed',
  'task_failed',
  'task_unknown',
  'phase_completed',
  'blocker',
  'finding',
  'decision_required',
  'decision_resolved',
]);

/**
 * Kinds that are explicitly NOT material progress, listed so the exclusion is a
 * decision rather than an omission.
 *
 * `material_progress` is on this list despite its name. The ACP adapter emits it
 * for token, tool-call and usage stream updates, which is exactly the streaming
 * signal the authority rules out. `phase_progress` is the same shape.
 * `permission`, `attention`, `runtime_health` and `transport_uncertainty` are
 * liveness and condition telemetry: an agent can emit them forever while
 * producing nothing, which is the stall this budget exists to detect.
 */
export const NON_PROGRESS_EVENT_KINDS = new Set([
  'material_progress',
  'phase_progress',
  'permission',
  'attention',
  'runtime_health',
  'transport_uncertainty',
]);

const laterOf = (current: MaterialProgress, at: string, source: MaterialProgress['source']): MaterialProgress =>
  Date.parse(at) > Date.parse(current.at) ? { at, source } : current;

/**
 * Reduce a signal stream to the signals that are evidence of work.
 *
 * A commit is evidence the first time its digest is seen. A runtime observation
 * is evidence only when it DIFFERS from the previous observation of the same
 * subject: the first sample establishes a baseline, and a run of identical
 * samples is a keepalive. Counting either as progress would keep an inactivity
 * budget silent on an agent that has stalled while still being polled.
 */
export function progressSignals(signals: SupervisionSignal[]): SupervisionSignal[] {
  const ordered = [...signals].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  const seen = new Map<string, string>();
  const progress: SupervisionSignal[] = [];
  for (const signal of ordered) {
    const key = `${signal.subjectId}:${signal.kind}`;
    const previous = seen.get(key);
    seen.set(key, signal.digest);
    if (previous === signal.digest) continue;
    if (previous === undefined && signal.kind === 'runtime_observation') continue;
    progress.push(signal);
  }
  return progress;
}

/**
 * The last moment a subject produced durable evidence of work.
 *
 * Sources, all durable: the subject's own creation and last durable state
 * change, a Result, a Knowledge entry, a durable-kind ChannelEvent, a commit, or
 * a runtime observation whose content differs from the previous one.
 */
export function materialProgressAt(view: SupervisionView, subject: SupervisedSubject): MaterialProgress {
  let progress: MaterialProgress = { at: subject.createdAt, source: 'subject_created' };
  progress = laterOf(progress, subject.updatedAt, 'state_change');
  for (const result of view.results) if (result.taskId === subject.id) progress = laterOf(progress, result.createdAt, 'result');
  for (const entry of view.knowledge) if (entry.taskId === subject.id) progress = laterOf(progress, entry.createdAt, 'knowledge');
  for (const event of view.events) {
    if (event.taskId !== subject.id) continue;
    if (!DURABLE_PROGRESS_EVENT_KINDS.has(event.kind)) continue;
    progress = laterOf(progress, event.createdAt, 'event');
  }
  for (const signal of progressSignals(view.signals.filter((item) => item.subjectId === subject.id))) {
    progress = laterOf(progress, signal.observedAt, signal.kind === 'commit' ? 'commit' : 'runtime_observation');
  }
  return progress;
}

const digestId = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

/** Both ids are derived from the breach identity, so the same breach observed
 * again — including after a restart — addresses the same durable records. */
export const supervisionReviewId = (policyId: string, subjectId: string, generation: number, reason: SupervisionReason): string =>
  digestId('supervision', `${policyId}:${subjectId}:${generation}:${reason}`);
export const supervisionEventId = (policyId: string, subjectId: string, generation: number, reason: SupervisionReason): string =>
  digestId('event', `supervision:${policyId}:${subjectId}:${generation}:${reason}`);

export const supervisionPolicyId = (workspaceId: string): string => digestId('policy', `supervision:${workspaceId}`);
export const supervisionSignalId = (subjectId: string, kind: SupervisionSignalKind, digest: string, observedAt: string): string =>
  digestId('signal', `${subjectId}:${kind}:${digest}:${observedAt}`);

/**
 * Decide which subjects have breached a budget right now.
 *
 * Returns breaches only. It never decides what to do about them: killing,
 * retrying or duplicating work is out of this module's vocabulary by design.
 */
export function evaluateSupervision(view: SupervisionView, nowMs: number): SupervisionBreach[] {
  const breaches: SupervisionBreach[] = [];
  const breachedThisPass = new Set<string>();
  const policies = [...view.policies].sort((a, b) => a.id.localeCompare(b.id));
  for (const policy of policies) {
    if (!policy.automatic) continue;
    if (policy.reviewAfterMs === undefined && policy.inactivityAfterMs === undefined) continue;
    const subjects = view.subjects
      .filter((subject) => subject.workspaceId === policy.workspaceId && SUPERVISED_LIFECYCLES.has(subject.lifecycle) && subject.scope !== 'steward_analysis' && subject.ownerRole !== 'steward' && subject.ownerRole !== 'steward-analyst')
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const subject of subjects) {
      if (breachedThisPass.has(subject.id)) continue;
      const reviews = view.reviews.filter((review) => review.subjectId === subject.id);
      // Cooldown: a subject that has already produced a review is quiet until
      // the cooldown lapses, whatever happens to its generation in between.
      if (reviews.some((review) => Date.parse(review.cooldownUntil) > nowMs)) continue;
      const progress = materialProgressAt(view, subject);
      const reason: SupervisionReason | undefined =
        policy.reviewAfterMs !== undefined && nowMs - Date.parse(subject.createdAt) >= policy.reviewAfterMs ? 'review_budget'
          : policy.inactivityAfterMs !== undefined && nowMs - Date.parse(progress.at) >= policy.inactivityAfterMs ? 'inactivity_budget'
            : undefined;
      if (!reason) continue;
      // Dedupe: one breach per subject and generation, whatever the tick rate.
      if (reviews.some((review) => review.policyId === policy.id && review.generation === subject.generation)) continue;
      breachedThisPass.add(subject.id);
      breaches.push({
        reviewId: supervisionReviewId(policy.id, subject.id, subject.generation, reason),
        eventId: supervisionEventId(policy.id, subject.id, subject.generation, reason),
        policyId: policy.id,
        workspaceId: policy.workspaceId,
        subjectKind: 'task',
        subjectId: subject.id,
        generation: subject.generation,
        reason,
        breachedAt: new Date(nowMs).toISOString(),
        lastProgressAt: progress.at,
        cooldownUntil: new Date(nowMs + policy.cooldownMs).toISOString(),
      });
    }
  }
  return breaches;
}
