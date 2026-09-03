import type { ChannelEvent, Delivery, Goal, KnowledgeEntry, Member, Result, RuntimeSession, Task } from './arcp.js';
import type { ExecutionSurface, SurfaceClaim } from './execution-placement.js';

/**
 * The shared vocabulary of ARCP Coordination Observability.
 *
 * Three surfaces meet here and nowhere else: the Sequence fold that turns
 * durable records into one ordered causal narrative, the ReportingRoute that
 * says who owes an answer for a launch, and the anomaly projection that both
 * the human surfaces and the active patrol read. Keeping the vocabulary in one
 * module is what makes "patrol consumes the same projection" checkable rather
 * than aspirational: there is only one set of types to consume.
 *
 * Nothing here is durable state by itself except `ReportingRoute`, which is an
 * Owner-decided record. The Sequence and anomaly types are read-only views.
 */

/* ------------------------------------------------------------------ refs -- */

export type SequenceRefKind = 'workspace' | 'goal' | 'task' | 'result' | 'runtime' | 'delivery' | 'event' | 'member' | 'surface' | 'knowledge' | 'route';
export interface SequenceRef { kind: SequenceRefKind; id: string; label?: string }

/* --------------------------------------------------------- reporting route -- */

/** How the primary Delivery of a route closes. CC fan-out is never any of the
 * obligation-bearing values: only the primary Delivery carries an obligation. */
export type ReportingAckPolicy = 'none' | 'ack_required' | 'decision_required';

/** A route endpoint. Exactly one of `memberId` or `role` identifies it; a role
 * is an accountable intent that must resolve to one current member at use. */
export interface ReportingRecipient { memberId?: string; role?: string; label?: string }

export type ReportingTransitionKind = 'declared' | 'primary_changed' | 'escalated' | 'acknowledged' | 'closed';

/** One append-only step in a route's ownership history. Escalation changes the
 * accountable handler; it never mints a second obligation. */
export interface ReportingRouteTransition {
  id: string;
  at: string;
  kind: ReportingTransitionKind;
  from?: ReportingRecipient;
  to?: ReportingRecipient;
  reason: string;
  eventId?: string;
}

/**
 * The durable reporting topology of one Task or Runtime launch, separate from
 * transport delivery. Per the Owner topology decision: primary alone owns ACK,
 * verdict, rework dispatch and closure; CC is observe-only and must never block
 * progress.
 */
export interface ReportingRoute {
  id: string;
  workspaceId: string;
  subject: { kind: 'task' | 'runtime'; id: string };
  launchedByMemberId: string;
  primaryHandler: ReportingRecipient;
  ccRecipients: ReportingRecipient[];
  escalationChain: ReportingRecipient[];
  ackPolicy: ReportingAckPolicy;
  /** Time the primary has to acknowledge before SLA-driven escalation is due. */
  ackSlaMs?: number;
  transitions: ReportingRouteTransition[];
  createdAt: string;
  updatedAt: string;
}

/** The route-shaped meaning a Sequence entry carries, when it carries one. */
export interface SequenceRouteView {
  routeId: string;
  role: 'launcher' | 'primary' | 'cc' | 'escalation';
  recipient: ReportingRecipient;
  obligation: 'owned' | 'observe_only';
}

/* -------------------------------------------------------------- sequence -- */

export type SequenceEntryKind =
  | 'goal_started' | 'goal_contract_bound' | 'goal_state_changed'
  | 'task_created' | 'task_claimed' | 'task_fence_advanced' | 'task_lifecycle_changed'
  | 'runtime_launched' | 'runtime_generation_changed' | 'runtime_observed' | 'runtime_terminal'
  | 'delivery_queued' | 'delivery_safe_point' | 'delivery_attempted' | 'delivery_delivered'
  | 'delivery_processed' | 'delivery_acknowledged' | 'delivery_withdrawn' | 'delivery_undeliverable'
  | 'channel_event' | 'receipt'
  | 'result_submitted' | 'verdict_recorded'
  | 'surface_claimed' | 'surface_released' | 'surface_archived' | 'surface_restored'
  | 'knowledge_recorded'
  | 'route_declared' | 'route_fanout' | 'route_acknowledged' | 'route_handler_changed' | 'route_escalated';

export type SequenceCausalKind = 'caused_by' | 'supersedes' | 'resolves' | 'replaces' | 'acknowledges' | 'fans_out_from' | 'escalates';
export interface SequenceCausalLink { kind: SequenceCausalKind; entryId: string }

/**
 * The stable ordering discriminator. Sort is always (atMs, rank, key) and never
 * anything else, so two runs over the same durable facts produce byte-identical
 * order even when several records share a millisecond.
 *
 * `rank` orders classes of fact so a cause precedes its effect within one
 * instant; `key` is the entry id and breaks the final tie deterministically.
 */
export interface SequenceTiebreak { rank: number; key: string }

export interface SequenceEntry {
  /** Derived from the source record, never from list position. */
  id: string;
  at: string;
  atMs: number;
  tiebreak: SequenceTiebreak;
  kind: SequenceEntryKind;
  /** The Round/Goal/Task phase this entry belongs to, when one is provable. */
  stage?: string;
  subject: SequenceRef;
  actor?: { memberId?: string; label: string; role: string };
  headline: string;
  summary: string;
  refs: SequenceRef[];
  causal: SequenceCausalLink[];
  route?: SequenceRouteView;
  /** Scalar facts a renderer may show without re-reading durable state. */
  facts: Record<string, string | number | boolean>;
}

export interface SequenceProjection {
  schemaVersion: 'arcp.sequence/v1';
  generatedAt: string;
  entries: SequenceEntry[];
  /** One timeline per subject, entries already in canonical order. */
  timelines: Array<{ subject: SequenceRef; entryIds: string[] }>;
}

/* --------------------------------------------------------------- anomaly -- */

export type SequenceAnomalyKind =
  | 'contract_after_start'
  | 'candidate_before_contract'
  | 'late_self_wake'
  | 'stale_safe_point'
  | 'duplicate_goal'
  | 'duplicate_worker'
  | 'surface_conflict'
  | 'wrong_member_attribution';

export type SequenceAnomalySeverity = 'p0' | 'p1' | 'p2';

export interface SequenceAnomaly {
  id: string;
  kind: SequenceAnomalyKind;
  severity: SequenceAnomalySeverity;
  subject: SequenceRef;
  at: string;
  /** The Sequence entries that prove the anomaly. Never empty. */
  entryIds: string[];
  headline: string;
  /** Why these entries prove it, in terms a Manager can act on. */
  evidence: string;
  owner: string;
  nextAction: string;
}

export interface SequenceAnomalyProjection {
  schemaVersion: 'arcp.sequence-anomaly/v1';
  generatedAt: string;
  anomalies: SequenceAnomaly[];
}

/* ----------------------------------------------------------------- facts -- */

/**
 * The one read-only fact bundle every surface in this module consumes.
 * Builders never read the clock: production callers inject `nowMs`.
 */
export interface SequenceFacts {
  workspaceId?: string;
  channelEvents: readonly ChannelEvent[];
  deliveries: readonly Delivery[];
  tasks: readonly Task[];
  results: readonly Result[];
  sessions: readonly RuntimeSession[];
  members: readonly Member[];
  goals: readonly Goal[];
  knowledge: readonly KnowledgeEntry[];
  reportingRoutes: readonly ReportingRoute[];
  executionSurfaces: readonly ExecutionSurface[];
  surfaceClaims: readonly SurfaceClaim[];
  nowMs?: number;
}

/** Canonical comparator. Every ordered surface must use this and only this. */
export const compareSequenceEntries = (a: SequenceEntry, b: SequenceEntry): number =>
  a.atMs - b.atMs || a.tiebreak.rank - b.tiebreak.rank || (a.tiebreak.key < b.tiebreak.key ? -1 : a.tiebreak.key > b.tiebreak.key ? 1 : 0);

/**
 * Cause-before-effect ordering within one millisecond. Lower rank sorts first.
 * A kind absent from this table sorts last, deterministically, so adding a kind
 * degrades ordering rather than breaking it.
 */
export const SEQUENCE_RANK: Readonly<Record<SequenceEntryKind, number>> = Object.freeze({
  goal_started: 10, goal_contract_bound: 11, goal_state_changed: 12,
  task_created: 20, task_claimed: 21, task_fence_advanced: 22, task_lifecycle_changed: 23,
  surface_claimed: 30, surface_released: 31, surface_archived: 32, surface_restored: 33,
  runtime_launched: 40, runtime_generation_changed: 41, runtime_observed: 42, runtime_terminal: 43,
  route_declared: 50, route_fanout: 51, route_handler_changed: 52, route_escalated: 53, route_acknowledged: 54,
  delivery_queued: 60, delivery_safe_point: 61, delivery_attempted: 62, delivery_delivered: 63,
  delivery_processed: 64, delivery_acknowledged: 65, delivery_withdrawn: 66, delivery_undeliverable: 67,
  channel_event: 70, receipt: 71,
  result_submitted: 80, verdict_recorded: 81,
  knowledge_recorded: 90,
});

export const sequenceRankOf = (kind: SequenceEntryKind): number => SEQUENCE_RANK[kind] ?? 999;

/**
 * The `facts` keys a producer must set for a given entry kind.
 *
 * This is the load-bearing half of the seam. The fold decides which durable
 * records become entries; the anomaly projection and the human renderers read
 * only `facts`, never durable state. Without a named vocabulary the two halves
 * agree by accident, and a fold that renames one key silently empties a
 * detector instead of failing it.
 *
 * A kind absent from this table has no required keys. Extra keys are always
 * allowed: this is a floor, not a schema.
 */
export const SEQUENCE_REQUIRED_FACTS: Readonly<Partial<Record<SequenceEntryKind, readonly string[]>>> = Object.freeze({
  goal_started: ['goalId', 'title'],
  goal_contract_bound: ['goalId', 'boundAtLaunch'],
  task_created: ['taskId', 'fence'],
  task_claimed: ['taskId', 'fence', 'memberId'],
  task_fence_advanced: ['taskId', 'fence'],
  task_lifecycle_changed: ['taskId', 'lifecycle'],
  runtime_launched: ['runtimeId', 'lineageId', 'generation', 'provider', 'hasContract'],
  runtime_generation_changed: ['runtimeId', 'lineageId', 'generation'],
  runtime_terminal: ['runtimeId', 'lineageId', 'generation'],
  delivery_queued: ['deliveryId', 'lineageId', 'purpose', 'targetGeneration'],
  delivery_safe_point: ['deliveryId', 'lineageId', 'purpose', 'targetGeneration'],
  delivery_delivered: ['deliveryId', 'lineageId', 'purpose', 'targetGeneration'],
  delivery_processed: ['deliveryId', 'lineageId', 'purpose', 'targetGeneration'],
  delivery_acknowledged: ['deliveryId', 'lineageId', 'purpose', 'targetGeneration'],
  delivery_withdrawn: ['deliveryId', 'lineageId', 'purpose'],
  delivery_undeliverable: ['deliveryId', 'lineageId', 'purpose', 'undeliverableReason'],
  result_submitted: ['resultId', 'taskId', 'fence', 'memberId', 'status'],
  verdict_recorded: ['eventId', 'verdict'],
  surface_claimed: ['surfaceId', 'claimId', 'runtimeSessionId', 'active'],
  surface_released: ['surfaceId', 'claimId', 'runtimeSessionId', 'active'],
  route_declared: ['routeId', 'launchedByMemberId', 'ackPolicy'],
  route_fanout: ['routeId', 'obligation'],
  route_acknowledged: ['routeId'],
  route_handler_changed: ['routeId'],
  route_escalated: ['routeId'],
});

/**
 * The generation-spanning identity of a runtime lineage.
 *
 * ARCP models an advanced RuntimeGeneration as a NEW RuntimeSession row that
 * shares the previous row's `bindingId`. So `runtimeId` identifies one episode,
 * never the continuing thing that episode belongs to. Any rule that asks "has
 * this runtime moved on?" must join on the lineage, not the session id, or it
 * silently compares an old episode only against itself and never fires.
 *
 * Producers set `lineageId` from `RuntimeSession.bindingId`. Consumers join on
 * this and fall back to `runtimeId` only for records that predate the key.
 */
export const sequenceLineageOf = (entry: SequenceEntry): string | undefined => {
  const lineage = entry.facts.lineageId ?? entry.facts.runtimeId;
  return lineage === undefined ? entry.refs.find((ref) => ref.kind === 'runtime')?.id : String(lineage);
};

/** Which required `facts` keys an entry is missing. Empty means conformant. */
export const missingSequenceFacts = (entry: SequenceEntry): string[] =>
  (SEQUENCE_REQUIRED_FACTS[entry.kind] ?? []).filter((key) => entry.facts[key] === undefined);

