import { describe, expect, it } from 'vitest';
import { projectSequenceAnomalies, projectSequencePatrol } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-anomaly.js';
import { renderSequence, renderSequenceAnomalySurface } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-render.js';
import { missingSequenceFacts } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-model.js';

const base = Date.parse('2026-09-02T00:00:00.000Z');
const ref = (kind: any, id: string, label?: string) => ({ kind, id, ...(label ? { label } : {}) });
const entry = (id: string, kind: any, minute: number, facts: Record<string, string | number | boolean>, subject: any, refs: any[] = [], causal: any[] = []) => ({ id, kind, at: new Date(base + minute * 60_000).toISOString(), atMs: base + minute * 60_000, tiebreak: { rank: 1, key: id }, subject, headline: `${kind} headline`, summary: kind, refs, causal, facts });
const sequence = (entries: any[]) => ({ schemaVersion: 'arcp.sequence/v1' as const, generatedAt: new Date(base + 200 * 60_000).toISOString(), entries, timelines: [] });
const kinds = (entries: any[]) => projectSequenceAnomalies(sequence(entries)).anomalies.map((item) => item.kind);
const assertLegal = (entries: any[]) => expect(entries.flatMap(missingSequenceFacts)).toEqual([]);

describe('Sequence anomaly projection over legal Lane A entries', () => {
  it('episode A detects a candidate whose Goal Contract was bound after the candidate through Task → Runtime → Goal links', () => {
    const goal = ref('goal', 'g', 'Goal'), task = ref('task', 't', 'Task');
    const entries = [
      entry('goal', 'goal_started', 0, { goalId: 'g', title: 'Goal' }, goal),
      entry('runtime', 'runtime_launched', 1, { runtimeId: 'r', generation: 1, provider: 'codex', hasContract: true }, ref('runtime', 'r'), [goal, task]),
      entry('candidate', 'result_submitted', 2, { resultId: 'result', taskId: 't', fence: 1, memberId: 'm', status: 'candidate' }, task, [task]),
      entry('contract', 'goal_contract_bound', 3, { goalId: 'g', boundAtLaunch: false }, goal),
    ];
    assertLegal(entries);
    expect(kinds(entries)).toEqual(['contract_after_start', 'candidate_before_contract']);
  });

  it('episode B detects a stale safe point after terminal and generation replacement', () => {
    const runtime = ref('runtime', 'r');
    const entries = [
      entry('launch', 'runtime_launched', 0, { runtimeId: 'r', generation: 1, provider: 'codex', hasContract: true }, runtime),
      entry('terminal', 'runtime_terminal', 10, { runtimeId: 'r', generation: 1 }, runtime),
      entry('replace', 'runtime_generation_changed', 20, { runtimeId: 'r', generation: 2 }, runtime),
      entry('safe', 'delivery_safe_point', 100, { deliveryId: 'd', purpose: 'message', targetGeneration: 1 }, runtime, [runtime]),
    ];
    assertLegal(entries);
    expect(kinds(entries)).toEqual(['stale_safe_point']);
  });

  it('episode C detects a delivered late wake aimed at a superseded generation', () => {
    const runtime = ref('runtime', 'r'), task = ref('task', 't', 'Task');
    const entries = [
      entry('launch', 'runtime_launched', 0, { runtimeId: 'r', generation: 1, provider: 'codex', hasContract: true }, runtime, [task]),
      entry('replace', 'runtime_generation_changed', 20, { runtimeId: 'r', generation: 2 }, runtime),
      entry('delivered', 'delivery_delivered', 30, { deliveryId: 'd', purpose: 'message', targetGeneration: 1 }, task, [runtime, task]),
    ];
    assertLegal(entries);
    expect(kinds(entries)).toEqual(['late_self_wake']);
  });

  it('renders the Sequence, keeps patrol as the same projection, and includes p2 alerts', () => {
    const input = sequence([entry('launch', 'runtime_launched', 0, { runtimeId: 'r', generation: 1, provider: 'codex', hasContract: true }, ref('runtime', 'r', 'Codex worker'))]);
    expect(renderSequence(input)).toContain('runtime_launched · Codex worker');
    const projection = { schemaVersion: 'arcp.sequence-anomaly/v1' as const, generatedAt: input.generatedAt, anomalies: [{ id: 'p2', kind: 'duplicate_goal' as const, severity: 'p2' as const, subject: ref('goal', 'g'), at: input.generatedAt, entryIds: ['launch'], headline: 'Informational', evidence: 'Evidence', owner: 'Manager', nextAction: 'Observe' }] };
    const patrol = projectSequencePatrol(projection);
    expect(patrol.projection).toBe(projection);
    expect(patrol.alerts).toEqual(projection.anomalies);
    expect(renderSequenceAnomalySurface(projection)).toContain('Informational');
  });
});
