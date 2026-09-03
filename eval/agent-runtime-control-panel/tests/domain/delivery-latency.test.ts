import { describe, expect, it } from 'vitest';
import { projectDeliveryLatency, renderDeliveryLatency, type DeliveryLatencyFacts } from '../../../../skills/agent-runtime-control-panel/runtime/src/delivery-latency.js';
import { UNKNOWN } from '../../../../skills/agent-runtime-control-panel/runtime/src/control-panorama.js';

const WS = 'workspace-1';
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const at = (secondsAfterStart: number) => new Date(Date.parse('2026-09-03T11:00:00.000Z') + secondsAfterStart * 1000).toISOString();

const event = (over: Record<string, unknown> = {}) => ({
  id: 'event-1', workspaceId: WS, goalId: 'goal-1', taskId: 'task-1', kind: 'decision_required', urgency: 'normal', priority: 'normal',
  consumptionPolicy: 'decision_required', consumptionState: 'open', expectedAction: { kind: 'resolve', instruction: '' },
  dispositions: [], decisionRequired: true, content: { summary: 's', evidenceRefs: [], contentHash: 'h', sensitivity: 'normal', retention: 'standard' },
  deliveryState: 'delivered', transitions: [], createdAt: at(0), ...over,
}) as any;

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'delivery-1', fromActorId: 'actor-1', runtimeSessionId: 'runtime-1', generation: 1, body: '', command: 'normal',
  eventId: 'event-1', state: 'acknowledged', createdAt: at(10), ...over,
}) as any;

const facts = (over: Partial<DeliveryLatencyFacts> = {}): DeliveryLatencyFacts =>
  ({ workspaceId: WS, nowMs: NOW, events: [event()], deliveries: [delivery()], results: [], ...over });

describe('Delivery latency — the hops', () => {
  it('derives every hop from timestamps ARCP already records', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(30), processedAt: at(50), acknowledgedAt: at(80) })],
      deliveries: [delivery({ attemptedAt: at(20), deliveredAt: at(30), processedAt: at(50), acknowledgedAt: at(80) })],
    }));

    const [sample] = latency.samples;
    expect(sample.publishToEligible).toBe(10_000);   // created 0 -> delivery created 10
    expect(sample.eligibleToDelivered).toBe(20_000); // 10 -> 30, nothing waited
    expect(sample.deliveredToProcessed).toBe(20_000);
    expect(sample.processedToSettled).toBe(30_000);
  });

  it('settles on a disposition when there is no explicit acknowledgement', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(30), processedAt: at(50), dispositions: [{ kind: 'ack', actorMemberId: 'm', at: at(70) }] })],
      deliveries: [delivery({ deliveredAt: at(30), processedAt: at(50) })],
    }));
    expect(latency.samples[0].processedToSettled).toBe(20_000);
  });

  it('measures how long a candidate Result waited for its decision', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ id: 'event-decision', resultId: 'result-1', resolvedAt: at(300) })],
      deliveries: [],
      results: [{ id: 'result-1', workspaceId: WS, taskId: 'task-1', memberId: 'm', fence: 1, status: 'candidate', summary: 's', evidenceRefs: [], createdAt: at(120) } as any],
    }));
    expect(latency.resultToDisposition).toBe(180_000);
  });

  it('ages the oldest open obligation from the supplied clock', () => {
    const latency = projectDeliveryLatency(facts({ events: [event({ deliveredAt: at(0) })] }));
    expect(latency.oldestOpenObligationAgeMs).toBe(NOW - Date.parse(at(0)));
  });
});

describe('Delivery latency — a missing timestamp is unknown, never zero', () => {
  it('reports unknown for an unfinished hop while still reporting the finished ones', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(30) })],
      deliveries: [delivery({ deliveredAt: at(30) })],
    }));

    const [sample] = latency.samples;
    expect(sample.publishToEligible).toBe(10_000);
    expect(sample.eligibleToDelivered).toBe(20_000);
    // Never delivered onward: unknown, not an instant zero.
    expect(sample.deliveredToProcessed).toBe(UNKNOWN);
    expect(sample.processedToSettled).toBe(UNKNOWN);
  });

  it('never reports zero in place of an unrecorded endpoint', () => {
    const latency = projectDeliveryLatency(facts({ events: [event()], deliveries: [] }));
    const [sample] = latency.samples;
    for (const hop of [sample.eligibleToDelivered, sample.deliveredToProcessed, sample.processedToSettled, sample.safePointWait]) {
      expect(hop).toBe(UNKNOWN);
      expect(hop).not.toBe(0);
    }
    expect(sample.deliveryId).toBe(UNKNOWN);
  });

  it('reports unknown, not zero, when there is no Result to dispose of', () => {
    expect(projectDeliveryLatency(facts({ results: [] })).resultToDisposition).toBe(UNKNOWN);
  });

  it('does not start the clock on an obligation that is deliberately deferred out of sight', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ nextVisibleAt: at(600), deliveredAt: at(660) })],
      deliveries: [delivery({ deliveredAt: at(660) })],
    }));
    // Eligibility begins when it becomes visible again, not when it was published.
    expect(latency.samples[0].publishToEligible).toBe(600_000);
    expect(latency.samples[0].eligibleToDelivered).toBe(60_000);
  });
});

describe('Delivery latency — an intentional safe-point wait is not transport latency', () => {
  it('reports the wait separately and excludes it from the transport figure', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(100) })],
      // Held from 10 until a safe point at 70, then delivered at 100.
      deliveries: [delivery({ createdAt: at(10), safePointObservedAt: at(70), attemptedAt: at(70), deliveredAt: at(100) })],
    }));

    const [sample] = latency.samples;
    expect(sample.safePointWait).toBe(60_000);
    // 10 -> 100 is 90s, of which 60s was deliberate waiting: 30s is transport.
    expect(sample.eligibleToDelivered).toBe(30_000);
  });

  it('distinguishes a delivery that never waited (measured zero) from one we cannot see (unknown)', () => {
    const never = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(30) })],
      deliveries: [delivery({ attemptedAt: at(15), deliveredAt: at(30) })],
    }));
    expect(never.samples[0].safePointWait).toBe(0);

    const unseen = projectDeliveryLatency(facts({ events: [event()], deliveries: [delivery({ state: 'queued' })] }));
    expect(unseen.samples[0].safePointWait).toBe(UNKNOWN);
  });
});

describe('Delivery latency — duplicate wakes', () => {
  it('counts more than one wake on the same goal/task/generation/event key', () => {
    const latency = projectDeliveryLatency(facts({
      deliveries: [delivery({ id: 'delivery-1' }), delivery({ id: 'delivery-2' }), delivery({ id: 'delivery-3', generation: 2 })],
    }));

    expect(latency.duplicateWakes).toEqual([{ key: 'goal-1|task-1|1|event-1', count: 2 }]);
  });

  it('reports none when every wake is unique', () => {
    const latency = projectDeliveryLatency(facts({ deliveries: [delivery()] }));
    expect(latency.duplicateWakes).toEqual([]);
  });
});

describe('Delivery latency — rendering', () => {
  it('names the intentional wait as intentional so nobody optimises a working guard', () => {
    const latency = projectDeliveryLatency(facts({
      events: [event({ deliveredAt: at(100), processedAt: at(120), acknowledgedAt: at(140) })],
      deliveries: [delivery({ createdAt: at(10), safePointObservedAt: at(70), deliveredAt: at(100), processedAt: at(120), acknowledgedAt: at(140) })],
    }));
    const markdown = renderDeliveryLatency(latency);

    expect(markdown).toContain('## Latency');
    expect(markdown).toContain('safe-point wait (intentional, not transport)');
    expect(markdown).toContain('eligible → delivered (transport)');
    expect(markdown).toContain('Duplicate wakes: none');
  });

  it('shows unknown hops as unknown in the rendering', () => {
    const markdown = renderDeliveryLatency(projectDeliveryLatency(facts({ events: [event()], deliveries: [] })));
    expect(markdown).toContain(UNKNOWN);
  });
});
