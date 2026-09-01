import { createHash } from 'node:crypto';
import type { ChannelEvent, ChannelEventKind, ChannelTransition } from './arcp.js';

const TRANSITION_STATES: ChannelTransition['state'][] = [
  'queued', 'delivered', 'processed', 'acknowledged',
  'transport_indeterminate', 'undeliverable', 'withdrawn',
];

/** The one content-address function shared by native and legacy projections. */
export function contentAddress(summary: string, evidenceRefs: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ summary, evidenceRefs })).digest('hex');
}

function transitionState(value: unknown): ChannelTransition['state'] | undefined {
  return typeof value === 'string' && TRANSITION_STATES.includes(value as ChannelTransition['state'])
    ? value as ChannelTransition['state']
    : undefined;
}

/** Normalize both legacy flat events and native content-bearing events once. */
export function normalizeChannelEvent(value: Record<string, unknown>): ChannelEvent {
  const rawContent = value.content && typeof value.content === 'object' ? value.content as Record<string, unknown> : undefined;
  const summary = String(rawContent?.summary ?? value.summary ?? '');
  const rawEvidenceRefs = rawContent?.evidenceRefs ?? value.evidenceRefs;
  const evidenceRefs = Array.isArray(rawEvidenceRefs) ? rawEvidenceRefs.map(String) : [];
  const createdAt = String(value.createdAt ?? value.deliveredAt ?? value.processedAt ?? value.acknowledgedAt ?? '1970-01-01T00:00:00.000Z');
  const rawTransitions = Array.isArray(value.transitions) ? value.transitions
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map((item) => {
      const state = transitionState(item.state);
      return state && typeof item.at === 'string' ? { state, at: item.at } : undefined;
    }).filter((item): item is ChannelTransition => Boolean(item)) : [];
  const transitions: ChannelTransition[] = rawTransitions.length ? rawTransitions : [{ state: 'queued', at: createdAt }];
  if (!rawTransitions.length) {
    for (const state of ['delivered', 'processed', 'acknowledged'] as const) {
      const at = value[`${state}At`];
      if (typeof at === 'string') transitions.push({ state, at });
    }
  }
  const requestedFinal = transitionState(value.deliveryState);
  const final = requestedFinal ?? transitions.at(-1)!.state;
  if (!transitions.some((item) => item.state === final)) {
    const at = final === 'transport_indeterminate' && typeof value.transportUncertainAt === 'string'
      ? value.transportUncertainAt : createdAt;
    transitions.push({ state: final, at });
  }
  const { summary: _summary, evidenceRefs: _evidenceRefs, content: _content, transitions: _transitions,
    deliveryState: _deliveryState, createdAt: _createdAt, ...envelope } = value;
  return {
    ...envelope,
    kind: String(value.kind ?? 'finding') as ChannelEventKind,
    urgency: value.urgency === 'urgent' ? 'urgent' : 'normal',
    decisionRequired: Boolean(value.decisionRequired),
    content: {
      summary,
      evidenceRefs,
      contentHash: contentAddress(summary, evidenceRefs),
      sensitivity: rawContent?.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
      retention: rawContent?.retention === 'bounded' ? 'bounded' : 'standard',
    },
    deliveryState: final,
    transitions,
    createdAt,
  } as ChannelEvent;
}
