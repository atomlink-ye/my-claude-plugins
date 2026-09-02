import type { SequenceAnomaly, SequenceAnomalyProjection, SequenceProjection } from './sequence-model.js';

/** Compact causal timeline for a human snapshot; it does not inspect raw state. */
export function renderSequence(projection: SequenceProjection): string {
  const lines = [`Sequence · ${projection.entries.length} entries · generated ${projection.generatedAt}`];
  for (const entry of projection.entries) {
    const target = entry.subject.label ?? `${entry.subject.kind} ${entry.subject.id}`;
    lines.push(`[${entry.at}] ${entry.kind} · ${target}`);
    lines.push(`  ${entry.headline}`);
    if (entry.refs.length) lines.push(`  Refs: ${entry.refs.map((ref) => ref.label ?? `${ref.kind} ${ref.id}`).join(' · ')}`);
  }
  return lines.join('\n');
}

/** Compact, deliberately fact-free human rendering of the canonical anomalies. */
export function renderSequenceAnomaly(anomaly: SequenceAnomaly): string {
  return `[${anomaly.severity.toUpperCase()}] ${anomaly.headline}\nSubject: ${anomaly.subject.label ?? `${anomaly.subject.kind} ${anomaly.subject.id}`}\nEvidence: ${anomaly.evidence}\nOwner: ${anomaly.owner}\nNext: ${anomaly.nextAction}`;
}

export function renderSequenceAnomalySurface(projection: SequenceAnomalyProjection): string {
  if (!projection.anomalies.length) return 'Sequence patrol: no anomalies.';
  return [`Sequence patrol: ${projection.anomalies.length} ${projection.anomalies.length === 1 ? 'anomaly' : 'anomalies'}.`, ...projection.anomalies.map(renderSequenceAnomaly)].join('\n\n');
}
