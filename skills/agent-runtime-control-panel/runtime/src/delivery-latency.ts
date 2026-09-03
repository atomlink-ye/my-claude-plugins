/**
 * Where a coordination loop actually spent its time, derived from timestamps
 * ARCP already records. No new column, table or sampler.
 *
 * Two rules shape every number here:
 *
 * A missing endpoint is `unknown`, never zero. A zero reads as "instant" and
 * drags any average toward good news, hiding the very gap being measured.
 *
 * A delivery held at a safe point is ARCP deliberately waiting, not the
 * transport being slow. That wait is reported separately and subtracted from
 * transport, so nobody is tempted to "fix" a guard that is working.
 */
import type { ChannelEvent, Delivery, Result } from './arcp.js';
import { UNKNOWN, type Unknown } from './control-panorama.js';

export type Duration = number | Unknown;

export interface DeliveryLatencyFacts {
  workspaceId: string;
  nowMs: number;
  events: readonly ChannelEvent[];
  deliveries: readonly Delivery[];
  results: readonly Result[];
}

export interface DeliveryLatencyHops {
  publishToEligible: Duration;
  eligibleToDelivered: Duration;
  deliveredToProcessed: Duration;
  processedToSettled: Duration;
  safePointWait: Duration;
}

export interface DeliveryLatencySample extends DeliveryLatencyHops { eventId: string; deliveryId: string | Unknown; }
export interface DuplicateWake { key: string; count: number; }

export interface DeliveryLatency {
  samples: DeliveryLatencySample[];
  slowest: DeliveryLatencySample | Unknown;
  resultToDisposition: Duration;
  oldestOpenObligationAgeMs: Duration;
  duplicateWakes: DuplicateWake[];
}

const DUPLICATE_LIMIT = 5;
const ms = (value: string | undefined) => { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : undefined; };

/** A hop is a real duration only when both endpoints exist. */
const span = (from: number | undefined, to: number | undefined): Duration =>
  from === undefined || to === undefined ? UNKNOWN : Math.max(0, to - from);

const minus = (total: Duration, wait: Duration): Duration =>
  total === UNKNOWN ? UNKNOWN : Math.max(0, total - (wait === UNKNOWN ? 0 : wait));

const isOpen = (event: ChannelEvent) =>
  ['ack_required', 'decision_required'].includes(event.consumptionPolicy) && event.consumptionState === 'open';

export function projectDeliveryLatency(facts: DeliveryLatencyFacts): DeliveryLatency {
  const events = facts.events.filter((event) => event.workspaceId === facts.workspaceId);
  const deliveryFor = new Map<string, Delivery>();
  for (const delivery of facts.deliveries) if (delivery.eventId && !deliveryFor.has(delivery.eventId)) deliveryFor.set(delivery.eventId, delivery);

  const samples: DeliveryLatencySample[] = events.map((event) => {
    const delivery = deliveryFor.get(event.id);
    const published = ms(event.createdAt);
    // A deferred obligation is not late while it is deliberately invisible;
    // eligibility starts when it becomes visible again.
    const eligible = ms(event.nextVisibleAt) ?? ms(delivery?.createdAt) ?? published;
    const delivered = ms(delivery?.deliveredAt) ?? ms(event.deliveredAt);
    const processed = ms(delivery?.processedAt) ?? ms(event.processedAt);
    const settled = ms(delivery?.acknowledgedAt) ?? ms(event.acknowledgedAt)
      ?? ms(event.dispositions.at(0)?.at) ?? ms(event.resolvedAt);

    // A delivery that reached a safe point waited exactly that long. One that
    // was attempted without ever waiting waited zero — a measured zero, which
    // is a different statement from "we do not know". With no delivery at all,
    // we genuinely do not know.
    const safePointWait: Duration = !delivery ? UNKNOWN
      : delivery.safePointObservedAt ? span(ms(delivery.createdAt), ms(delivery.safePointObservedAt))
        : delivery.attemptedAt || delivery.deliveredAt ? 0
          : UNKNOWN;

    return {
      eventId: event.id,
      deliveryId: delivery?.id ?? UNKNOWN,
      publishToEligible: span(published, eligible),
      eligibleToDelivered: minus(span(eligible, delivered), safePointWait),
      deliveredToProcessed: span(delivered, processed),
      processedToSettled: span(processed, settled),
      safePointWait,
    };
  });

  const measured = (sample: DeliveryLatencySample) => {
    const total = [sample.publishToEligible, sample.eligibleToDelivered, sample.deliveredToProcessed, sample.processedToSettled]
      .filter((value): value is number => value !== UNKNOWN);
    return total.length ? total.reduce((sum, value) => sum + value, 0) : -1;
  };
  const slowest = [...samples].sort((a, b) => measured(a) - measured(b)).at(-1);

  const open = events.filter(isOpen);
  const oldestAt = open.map((event) => ms(event.deliveredAt) ?? ms(event.createdAt)).filter((value): value is number => value !== undefined).sort((a, b) => a - b).at(0);
  const oldestOpenObligationAgeMs: Duration = oldestAt === undefined ? UNKNOWN : Math.max(0, facts.nowMs - oldestAt);

  // How long a candidate Result waited for the accountable handler to rule.
  const latestResult = [...facts.results].filter((item) => item.workspaceId === facts.workspaceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const decision = latestResult ? events.find((event) => event.resultId === latestResult.id && event.consumptionPolicy === 'decision_required') : undefined;
  const resultToDisposition = span(ms(latestResult?.createdAt), ms(decision?.resolvedAt) ?? ms(decision?.dispositions.at(0)?.at));

  // One wake per key is correct; more than one is the duplicate-Worker and
  // duplicate-review failure this campaign has paid for repeatedly.
  const wakes = new Map<string, number>();
  for (const delivery of facts.deliveries) {
    const event = events.find((item) => item.id === delivery.eventId);
    if (!event) continue;
    const key = `${event.goalId ?? 'no-goal'}|${event.taskId ?? 'no-task'}|${delivery.generation}|${delivery.eventId ?? event.id}`;
    wakes.set(key, (wakes.get(key) ?? 0) + 1);
  }
  const duplicateWakes = [...wakes.entries()].filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, DUPLICATE_LIMIT);

  return { samples, slowest: slowest ?? UNKNOWN, resultToDisposition, oldestOpenObligationAgeMs, duplicateWakes };
}

const show = (value: Duration) => value === UNKNOWN ? UNKNOWN : `${Math.round(value / 1000)}s`;

export function renderDeliveryLatency(latency: DeliveryLatency): string {
  const lines: string[] = [];
  lines.push('## Latency');
  lines.push(`- Obligations measured: ${latency.samples.length}`);
  lines.push(`- Result → disposition: ${show(latency.resultToDisposition)}`);
  lines.push(`- Oldest open obligation: ${show(latency.oldestOpenObligationAgeMs)}`);
  if (latency.slowest === UNKNOWN) lines.push('- Slowest loop: unknown');
  else {
    const slowest = latency.slowest;
    lines.push(`- Slowest loop: ${slowest.eventId}`);
    lines.push(`  - publish → eligible: ${show(slowest.publishToEligible)}`);
    lines.push(`  - eligible → delivered (transport): ${show(slowest.eligibleToDelivered)}`);
    lines.push(`  - safe-point wait (intentional, not transport): ${show(slowest.safePointWait)}`);
    lines.push(`  - delivered → processed: ${show(slowest.deliveredToProcessed)}`);
    lines.push(`  - processed → settled: ${show(slowest.processedToSettled)}`);
  }
  lines.push(`- Duplicate wakes: ${latency.duplicateWakes.length ? latency.duplicateWakes.map((item) => `${item.key} ×${item.count}`).join('; ') : 'none'}`);
  return lines.join('\n');
}
