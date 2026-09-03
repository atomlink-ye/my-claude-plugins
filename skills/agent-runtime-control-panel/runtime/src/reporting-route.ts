import type { ReportingAckPolicy, ReportingRecipient, ReportingRoute, ReportingRouteTransition, ReportingTransitionKind } from './sequence-model.js';

/** The small read-only roster seam used to resolve role recipients. */
export interface ReportingRosterMember {
  readonly id: string;
  readonly role: string;
  readonly label?: string;
  readonly lifecycle?: string;
}

export interface ReportingRouteInput {
  readonly id?: string;
  readonly workspaceId: string;
  readonly subject: { readonly kind: 'task' | 'runtime'; readonly id: string };
  readonly launchedByMemberId: string;
  readonly primaryHandler: ReportingRecipient;
  readonly ccRecipients?: readonly ReportingRecipient[];
  readonly escalationChain?: readonly ReportingRecipient[];
  readonly ackPolicy?: ReportingAckPolicy;
  readonly ackSlaMs?: number;
  readonly createdAt?: string;
  readonly nowMs?: number;
}

export interface ReportingRouteValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ResolvedReportingRecipient {
  readonly recipient: ReportingRecipient;
  readonly member?: ReportingRosterMember;
  readonly resolved: boolean;
}

export interface ResolvedReportingRoute {
  readonly route: ReportingRoute;
  readonly primary: ResolvedReportingRecipient;
  readonly cc: readonly ResolvedReportingRecipient[];
  readonly escalation: readonly ResolvedReportingRecipient[];
}

export interface ReportingRouteOperation {
  readonly route: ReportingRoute;
  readonly changed: boolean;
  readonly transition?: ReportingRouteTransition;
  readonly reason?: string;
}

export interface ReportingDecisionInput {
  readonly memberId: string;
  readonly atMs: number;
  readonly resultId?: string;
  readonly candidateEventId?: string;
  /** The caller's durable proof that this decision belongs to this route. */
  readonly subject?: { readonly kind: 'task' | 'runtime'; readonly id: string };
  readonly reason?: string;
}

const ACTIVE_LIFECYCLES = new Set(['active', 'idle', 'busy', 'attention']);
const active = (member: ReportingRosterMember): boolean => member.lifecycle === undefined || ACTIVE_LIFECYCLES.has(member.lifecycle);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const recipientKey = (recipient: ReportingRecipient): string => recipient.memberId ? `member:${recipient.memberId}` : `role:${recipient.role}`;
const iso = (atMs: number): string => {
  if (!Number.isFinite(atMs)) throw new ReportingRouteError('atMs must be finite');
  return new Date(atMs).toISOString();
};
const transitionId = (route: ReportingRoute, kind: ReportingTransitionKind, at: string): string => `route_transition:${route.id}:${kind}:${at}:${route.transitions.length}`;

export class ReportingRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportingRouteError';
  }
}

export function validateReportingRecipient(recipient: ReportingRecipient, field = 'recipient'): readonly string[] {
  const identities = [recipient.memberId, recipient.role].filter(text);
  if (identities.length !== 1) return [`${field} must identify exactly one memberId or role`];
  return [];
}

export function validateReportingRoute(route: ReportingRoute, roster: readonly ReportingRosterMember[] = []): ReportingRouteValidation {
  const errors: string[] = [];
  if (!text(route.id)) errors.push('route id is required');
  if (!text(route.workspaceId)) errors.push('workspaceId is required');
  if (!route.subject || !text(route.subject.id)) errors.push('subject id is required');
  if (!text(route.launchedByMemberId)) errors.push('launchedByMemberId is required');
  errors.push(...validateReportingRecipient(route.primaryHandler, 'primaryHandler'));
  route.ccRecipients.forEach((recipient, index) => errors.push(...validateReportingRecipient(recipient, `ccRecipients[${index}]`)));
  route.escalationChain.forEach((recipient, index) => errors.push(...validateReportingRecipient(recipient, `escalationChain[${index}]`)));
  const primaryKey = recipientKey(route.primaryHandler);
  if (route.ccRecipients.some((recipient) => recipientKey(recipient) === primaryKey)) errors.push('primaryHandler cannot also be a CC recipient');
  const keys = new Set<string>();
  for (const recipient of [route.primaryHandler, ...route.ccRecipients, ...route.escalationChain]) {
    const key = recipientKey(recipient);
    if (keys.has(key)) errors.push(`duplicate route recipient ${key}`);
    keys.add(key);
  }
  if (!['none', 'ack_required', 'decision_required'].includes(route.ackPolicy)) errors.push('ackPolicy is invalid');
  if (route.ackSlaMs !== undefined && (!Number.isFinite(route.ackSlaMs) || route.ackSlaMs < 0)) errors.push('ackSlaMs must be a non-negative finite number');
  if (route.ackPolicy === 'none' && route.ackSlaMs !== undefined) errors.push('ackSlaMs requires an acknowledgement policy');
  if (roster.length) {
    if (!roster.some((member) => member.id === route.launchedByMemberId && active(member))) errors.push('launcher is not uniquely active in the roster');
    for (const [field, recipient] of [['primaryHandler', route.primaryHandler] as const, ...route.ccRecipients.map((value, index) => [`ccRecipients[${index}]`, value] as const), ...route.escalationChain.map((value, index) => [`escalationChain[${index}]`, value] as const)]) {
      if (!resolveReportingRecipient(recipient, roster).resolved) errors.push(`${field} does not resolve to exactly one active roster member`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function isValidReportingRoute(route: ReportingRoute, roster: readonly ReportingRosterMember[] = []): boolean {
  return validateReportingRoute(route, roster).valid;
}

/** Construct a canonical route without reading a clock or mutating input. */
export function buildReportingRoute(input: ReportingRouteInput): ReportingRoute {
  const createdAt = input.createdAt ?? iso(input.nowMs ?? 0);
  const route: ReportingRoute = {
    id: input.id ?? `route:${input.workspaceId}:${input.subject.kind}:${input.subject.id}`,
    workspaceId: input.workspaceId,
    subject: { kind: input.subject.kind, id: input.subject.id },
    launchedByMemberId: input.launchedByMemberId,
    primaryHandler: { ...input.primaryHandler },
    ccRecipients: (input.ccRecipients ?? []).map((recipient) => ({ ...recipient })),
    escalationChain: (input.escalationChain ?? []).map((recipient) => ({ ...recipient })),
    ackPolicy: input.ackPolicy ?? (input.ackSlaMs === undefined ? 'none' : 'ack_required'),
    ...(input.ackSlaMs === undefined ? {} : { ackSlaMs: input.ackSlaMs }),
    transitions: [{ id: `route_transition:${input.id ?? `route:${input.workspaceId}:${input.subject.kind}:${input.subject.id}`}:declared:${createdAt}:0`, at: createdAt, kind: 'declared', to: { ...input.primaryHandler }, reason: 'route declared' }],
    createdAt,
    updatedAt: createdAt,
  };
  const validation = validateReportingRoute(route);
  if (!validation.valid) throw new ReportingRouteError(validation.errors.join('; '));
  return route;
}

export function resolveReportingRecipient(recipient: ReportingRecipient, roster: readonly ReportingRosterMember[]): ResolvedReportingRecipient {
  const candidates = recipient.memberId
    ? roster.filter((member) => member.id === recipient.memberId && active(member))
    : roster.filter((member) => member.role === recipient.role && active(member));
  return { recipient: { ...recipient }, ...(candidates.length === 1 ? { member: candidates[0] } : {}), resolved: candidates.length === 1 };
}

export function resolveReportingRoute(route: ReportingRoute, roster: readonly ReportingRosterMember[]): ResolvedReportingRoute {
  return {
    route: cloneReportingRoute(route),
    primary: resolveReportingRecipient(route.primaryHandler, roster),
    cc: route.ccRecipients.map((recipient) => resolveReportingRecipient(recipient, roster)),
    escalation: route.escalationChain.map((recipient) => resolveReportingRecipient(recipient, roster)),
  };
}

const cloneReportingRoute = (route: ReportingRoute): ReportingRoute => ({
  ...route,
  subject: { ...route.subject },
  primaryHandler: { ...route.primaryHandler },
  ccRecipients: route.ccRecipients.map((recipient) => ({ ...recipient })),
  escalationChain: route.escalationChain.map((recipient) => ({ ...recipient })),
  transitions: route.transitions.map((transition) => ({ ...transition, ...(transition.from ? { from: { ...transition.from } } : {}), ...(transition.to ? { to: { ...transition.to } } : {}) })),
});

const withTransition = (route: ReportingRoute, transition: ReportingRouteTransition): ReportingRoute => ({ ...cloneReportingRoute(route), transitions: [...route.transitions, transition], updatedAt: transition.at });
const currentPrimaryMember = (route: ReportingRoute, roster: readonly ReportingRosterMember[], memberId: string): boolean => resolveReportingRecipient(route.primaryHandler, roster).member?.id === memberId;
const assertCurrentPrimary = (route: ReportingRoute, roster: readonly ReportingRosterMember[], memberId: string): void => {
  if (!currentPrimaryMember(route, roster, memberId)) throw new ReportingRouteError('only the current primary handler may operate this route');
};

/** ACK is owned by the primary; decision-required routes require a verdict. */
export function acknowledgeReportingRoute(route: ReportingRoute, memberId: string, atMs: number, roster: readonly ReportingRosterMember[], reason = 'acknowledged'): ReportingRouteOperation {
  if (route.ackPolicy === 'decision_required') throw new ReportingRouteError('decision-required routes must be resolved with a verdict');
  if (route.ackPolicy === 'none') throw new ReportingRouteError('route does not require acknowledgement');
  assertCurrentPrimary(route, roster, memberId);
  if (route.transitions.some((transition) => transition.kind === 'acknowledged' || transition.kind === 'closed')) return { route: cloneReportingRoute(route), changed: false, reason: 'route already acknowledged or closed' };
  if (!text(reason)) throw new ReportingRouteError('acknowledgement reason is required');
  const at = iso(atMs);
  const transition: ReportingRouteTransition = { id: transitionId(route, 'acknowledged', at), at, kind: 'acknowledged', from: { ...route.primaryHandler }, reason };
  return { route: withTransition(route, transition), changed: true, transition };
}

const nextEscalation = (route: ReportingRoute): ReportingRecipient | undefined => {
  const index = route.escalationChain.findIndex((recipient) => recipientKey(recipient) === recipientKey(route.primaryHandler));
  return route.escalationChain[index + 1] ?? route.escalationChain[index === -1 ? 0 : -1];
};

export function escalateReportingRoute(route: ReportingRoute, memberId: string, atMs: number, roster: readonly ReportingRosterMember[], reason = 'ACK SLA expired'): ReportingRouteOperation {
  assertCurrentPrimary(route, roster, memberId);
  if (route.transitions.some((transition) => transition.kind === 'acknowledged' || transition.kind === 'closed')) return { route: cloneReportingRoute(route), changed: false, reason: 'route already acknowledged or closed' };
  const next = nextEscalation(route);
  if (!next) return { route: cloneReportingRoute(route), changed: false, reason: 'route has no next escalation recipient' };
  const resolved = resolveReportingRecipient(next, roster);
  if (!resolved.resolved) throw new ReportingRouteError('next escalation recipient does not resolve to exactly one active roster member');
  const at = iso(atMs);
  const transition: ReportingRouteTransition = { id: transitionId(route, 'escalated', at), at, kind: 'escalated', from: { ...route.primaryHandler }, to: { ...next }, reason };
  return { route: withTransition({ ...route, primaryHandler: { ...next } }, transition), changed: true, transition };
}

export function reconcileReportingRoute(route: ReportingRoute, roster: readonly ReportingRosterMember[], atMs: number): ReportingRouteOperation {
  if (route.ackSlaMs === undefined || route.ackPolicy === 'none' || route.transitions.some((transition) => transition.kind === 'acknowledged' || transition.kind === 'closed')) return { route: cloneReportingRoute(route), changed: false, reason: 'route is not due' };
  const last = [...route.transitions].reverse().find((transition) => transition.kind === 'declared' || transition.kind === 'escalated');
  if (!last || atMs - Date.parse(last.at) < route.ackSlaMs) return { route: cloneReportingRoute(route), changed: false, reason: 'route is not due' };
  const primary = resolveReportingRecipient(route.primaryHandler, roster);
  if (!primary.member) return { route: cloneReportingRoute(route), changed: false, reason: 'current primary does not resolve to exactly one active roster member' };
  return escalateReportingRoute(route, primary.member.id, atMs, roster);
}

/** Close only a result-backed candidate obligation answered by the current primary. */
export function resolveReportingDecision(route: ReportingRoute, input: ReportingDecisionInput, roster: readonly ReportingRosterMember[]): ReportingRouteOperation {
  if (route.ackPolicy !== 'decision_required') throw new ReportingRouteError('route does not require a decision');
  if (!input.resultId || !input.candidateEventId) throw new ReportingRouteError('a resultId and candidateEventId are required to close a route');
  if (!input.subject || input.subject.kind !== route.subject.kind || input.subject.id !== route.subject.id) throw new ReportingRouteError('decision obligation does not belong to this route subject');
  assertCurrentPrimary(route, roster, input.memberId);
  if (route.transitions.some((transition) => transition.kind === 'closed')) return { route: cloneReportingRoute(route), changed: false, reason: 'route already closed' };
  const at = iso(input.atMs);
  const transition: ReportingRouteTransition = { id: transitionId(route, 'closed', at), at, kind: 'closed', from: { ...route.primaryHandler }, reason: input.reason ?? 'candidate decision resolved', eventId: input.candidateEventId };
  return { route: withTransition(route, transition), changed: true, transition };
}

export const routeRecipientKey = recipientKey;
export const cloneReportingRouteValue = cloneReportingRoute;
