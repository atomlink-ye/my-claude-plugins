import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { RuntimeBudgetTracker } from '../../../skills/agent-runtime-control-panel/runtime/src/runtime-budget.js';
import { evaluateAdmission, PROVIDER_BUDGET_SCHEMA, validateProviderBudgetEnvelope } from '../../../skills/agent-runtime-control-panel/runtime/src/provider-budget.js';

describe('aggregate runtime burn MVE', () => {
  it('deduplicates native turns and identifies the aggregate Opus wake storm without a transcript', () => {
    const tracker = new RuntimeBudgetTracker(); const started = Date.parse('2026-09-02T00:00:00Z');
    for (let index = 0; index < 232; index++) expect(tracker.record({ runtimeSessionId: 'opus-manager', providerId: 'claude', model: 'claude-opus-5', sampledAt: new Date(started + index * 20_000).toISOString(), sourceEventId: `message-${index}`, turnCountDelta: 1, cacheReadTokensDelta: index === 0 ? 39_137_041 - 231 * 168_694 : 168_694, cacheCreationTokensDelta: index === 0 ? 354_022 - 231 * 1_526 : 1_526, outputTokensDelta: index === 0 ? 86_825 : index >= 216 ? 3_000 : 0, contextUsed: 271_000, contextMax: 300_000, wakeCategory: index >= 229 ? 'channel_retry' : 'unknown' })).toBe(true);
    expect(tracker.record({ runtimeSessionId: 'opus-manager', providerId: 'claude', model: 'claude-opus-5', sampledAt: new Date(started).toISOString(), sourceEventId: 'message-0', turnCountDelta: 99 })).toBe(false);
    const view = tracker.view('opus-manager', { maxOutputTokensPerMinute: 3_000, maxTurnsPerMinute: 2, maxRepeatedWakeCount: 3, contextRatio: 0.85 }, started + 80 * 60_000);
    expect(view).toMatchObject({ samples: 232, turnCount: 232, cacheReadTokens: 39_137_041, cacheCreationTokens: 354_022, outputTokens: 134_825, staleWakeCount: 3 });
    expect(view.signals).toEqual(expect.arrayContaining(['RATE_DRAIN', 'TURN_STORM', 'STALE_WAKE', 'CONTEXT_DRAIN']));
  });
  it('keeps routing a recommendation until preflight validates its target binding', () => {
    const envelope = validateProviderBudgetEnvelope({ schemaVersion: PROVIDER_BUDGET_SCHEMA, source: { id: 'local', kind: 'command', observedAt: new Date().toISOString(), trust: 'authoritative', estimated: false, automaticAdmissionEligible: true }, providers: [{ providerId: 'claude', status: 'available', windows: [{ id: 'five-hour', label: '5h', usedPct: 85 }] }] });
    expect(evaluateAdmission({ envelope, providerId: 'claude', model: 'claude-opus-5', bindings: [{ id: 'claude', providerId: 'claude', sourceId: 'local', windowIds: ['five-hour'], admissionPolicyId: 'route' }], policies: [{ id: 'route', maxAgeMs: 300_000, drainRemainingPct: 20, hardDrainRemainingPct: 10, recommendedProviderProfile: 'codex-worker' }] })).toMatchObject({ action: 'drain', recommendedProviderProfile: 'codex-worker' });
  });
  it('holds a new provider launch when an active runtime has a burn signal', async () => {
    const cli = { run: async (args: string[]) => args[1] === 'ls' ? { value: [{ provider: 'claude', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' } : { value: [{ id: 'claude-opus-5', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' } };
    const service = new ArcpService(await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-budget-')), cli as any); await service.init();
    await service.store.mutate((state: any) => state.sessions.push({ id: 'hot-runtime', provider: 'claude', model: 'claude-opus-5', state: 'running' }));
    service.recordRuntimeBudgetSample({ runtimeSessionId: 'hot-runtime', providerId: 'claude', model: 'claude-opus-5', sampledAt: new Date().toISOString(), sourceEventId: 'turn-1', turnCountDelta: 1, outputTokensDelta: 16_000 });
    await expect(service.preflight({ profileId: 'claude-manager' })).resolves.toMatchObject({ action: 'hold', launchable: false, runtimeSignals: ['RATE_DRAIN'] }); service.close();
  });
});
