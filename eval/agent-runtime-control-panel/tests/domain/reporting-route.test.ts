import { describe, expect, it } from 'vitest';
import { acknowledgeReportingRoute, buildReportingRoute, escalateReportingRoute, reconcileReportingRoute, resolveReportingRecipient, resolveReportingRoute, resolveReportingDecision, validateReportingRoute } from '../../../../skills/agent-runtime-control-panel/runtime/src/reporting-route.js';

const at = '2026-09-02T00:00:00.000Z';
const roster = [
  { id: 'launcher', role: 'worker', label: 'Launcher', lifecycle: 'active' },
  { id: 'primary', role: 'manager', label: 'Primary', lifecycle: 'active' },
  { id: 'cc', role: 'observer', label: 'CC', lifecycle: 'idle' },
  { id: 'escalation', role: 'on-call', label: 'Escalation', lifecycle: 'active' },
] as const;

function route(overrides: Partial<Parameters<typeof buildReportingRoute>[0]> = {}) {
  return buildReportingRoute({
    id: 'route-1', workspaceId: 'workspace-1', subject: { kind: 'task', id: 'task-1' }, launchedByMemberId: 'launcher', primaryHandler: { memberId: 'primary' }, ccRecipients: [{ memberId: 'cc' }], escalationChain: [{ memberId: 'escalation' }], ackPolicy: 'ack_required', ackSlaMs: 1_000, createdAt: at, ...overrides,
  });
}

describe('pure ReportingRoute domain', () => {
  it('constructs and validates canonical primary, CC, escalation, and SLA topology', () => {
    const value = route();
    expect(validateReportingRoute(value, roster)).toEqual({ valid: true, errors: [] });
    expect(resolveReportingRoute(value, roster)).toMatchObject({ primary: { member: { id: 'primary' }, resolved: true }, cc: [{ member: { id: 'cc' }, resolved: true }], escalation: [{ member: { id: 'escalation' }, resolved: true }] });
  });

  it('resolves a role only when exactly one active roster member matches', () => {
    expect(resolveReportingRecipient({ role: 'manager' }, roster)).toMatchObject({ resolved: true, member: { id: 'primary' } });
    expect(resolveReportingRecipient({ role: 'missing' }, roster).resolved).toBe(false);
    expect(resolveReportingRecipient({ role: 'manager' }, [...roster, { id: 'manager-2', role: 'manager', lifecycle: 'active' }]).resolved).toBe(false);
  });

  it('allows only the primary to ACK and keeps CC observe-only', () => {
    expect(() => acknowledgeReportingRoute(route(), 'cc', 100, roster)).toThrow(/primary/);
    const result = acknowledgeReportingRoute(route(), 'primary', 100, roster, 'seen');
    expect(result.changed).toBe(true);
    expect(result.route.transitions.at(-1)).toMatchObject({ kind: 'acknowledged', reason: 'seen' });
  });

  it('escalates accountability without minting a second obligation', () => {
    const result = escalateReportingRoute(route(), 'primary', 1_000, roster);
    expect(result.route.primaryHandler).toEqual({ memberId: 'escalation' });
    expect(result.route.ccRecipients).toEqual([{ memberId: 'cc' }]);
    expect(result.route.transitions.filter((transition) => transition.kind === 'escalated')).toHaveLength(1);
  });

  it('reconciles only after the injected ACK SLA and stops after ACK/closure', () => {
    const declaredAt = Date.parse(at);
    expect(reconcileReportingRoute(route(), roster, declaredAt + 999).changed).toBe(false);
    const escalated = reconcileReportingRoute(route(), roster, declaredAt + 1_000);
    expect(escalated.changed).toBe(true);
    expect(reconcileReportingRoute(escalated.route, roster, declaredAt + 2_000).changed).toBe(false);
    expect(reconcileReportingRoute(acknowledgeReportingRoute(route(), 'primary', declaredAt + 100, roster).route, roster, declaredAt + 10_000).changed).toBe(false);
  });

  it('rejects plain ACK for decision routes and closes only a matching candidate decision', () => {
    const decisionRoute = route({ ackPolicy: 'decision_required' });
    expect(() => acknowledgeReportingRoute(decisionRoute, 'primary', 100, roster)).toThrow(/decision/);
    expect(() => resolveReportingDecision(decisionRoute, { memberId: 'primary', atMs: 100, resultId: 'other-result', candidateEventId: 'other-candidate', subject: { kind: 'task', id: 'other-task' } }, roster)).toThrow(/does not belong/);
    const closed = resolveReportingDecision(decisionRoute, { memberId: 'primary', atMs: 100, resultId: 'result-1', candidateEventId: 'candidate-1', subject: decisionRoute.subject, reason: 'accepted' }, roster);
    expect(closed.route.transitions.at(-1)).toMatchObject({ kind: 'closed', eventId: 'candidate-1' });
  });

  it('fails closed when durable primary or CC roles are ambiguous or inactive', () => {
    const roleRoute = route({ primaryHandler: { role: 'manager' }, ccRecipients: [{ role: 'observer' }] });
    expect(validateReportingRoute(roleRoute, roster).valid).toBe(true);
    const ambiguous = [...roster, { id: 'manager-2', role: 'manager', lifecycle: 'active' }] as const;
    expect(resolveReportingRoute(roleRoute, ambiguous).primary.resolved).toBe(false);
    const offline = roster.map((member) => member.id === 'cc' ? { ...member, lifecycle: 'offline' } : member);
    expect(resolveReportingRoute(roleRoute, offline).cc[0].resolved).toBe(false);
    expect(() => buildReportingRoute({ ...route(), primaryHandler: { memberId: 'primary' }, ackPolicy: 'none', ackSlaMs: 1 })).toThrow(/ackSlaMs/);
  });
});
