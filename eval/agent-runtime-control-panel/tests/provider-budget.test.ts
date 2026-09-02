import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCodexbar, collectPiGrokCache, PROVIDER_BUDGET_SCHEMA, evaluateAdmission, translatePaseoProviderUsage, validateProviderBudgetEnvelope } from '../../../skills/agent-runtime-control-panel/runtime/src/provider-budget.js';
import { providerBudgetEpisodeKey } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

const envelope = (remaining = 15, observedAt = new Date().toISOString()) => validateProviderBudgetEnvelope({
  schemaVersion: PROVIDER_BUDGET_SCHEMA, source: { id: 'local-codexbar', kind: 'command', observedAt, trust: 'authoritative', estimated: false, automaticAdmissionEligible: true }, providers: [
    { providerId: 'claude', status: 'available', windows: [{ id: 'primary', label: '5h', usedPct: 100 - remaining, resetsAt: '2026-09-02T12:00:00Z', ...(remaining <= 20 ? { runsOutAt: '2026-09-02T08:00:00Z' } : {}), scope: 'session' }] },
    { providerId: 'codex', status: 'available', windows: [{ id: 'secondary', label: 'weekly', usedPct: 28, scope: 'weekly' }] },
  ],
});

describe('provider budget MVE', () => {
  const bindings = [{ id: 'claude-5h', providerId: 'claude', sourceId: 'local-codexbar', modelPatterns: ['claude-opus-5', 'claude-sonnet-5'], windowIds: ['primary'], admissionPolicyId: 'default' }, { id: 'codex-weekly', providerId: 'codex', sourceId: 'local-codexbar', modelPatterns: ['gpt-5.6-terra'], windowIds: ['secondary'], admissionPolicyId: 'default' }];
  const policies = [{ id: 'default', maxAgeMs: 300_000, drainRemainingPct: 20, hardDrainRemainingPct: 10 }];
  it('normalizes a partial provider envelope and drains Claude while allowing Codex', () => {
    const snapshot = envelope();
    expect(snapshot.source).toMatchObject({ trust: 'authoritative', estimated: false, automaticAdmissionEligible: true });
    expect(snapshot.providers[0].windows[0]).toMatchObject({ usedPct: 85, remainingPct: 15 });
    expect(evaluateAdmission({ envelope: snapshot, bindings, policies, providerId: 'claude', model: 'claude-opus-5' }).action).toBe('drain');
    expect(evaluateAdmission({ envelope: snapshot, bindings, policies, providerId: 'codex', model: 'gpt-5.6-terra' }).action).toBe('launch');
  });
  it('rejects duplicate windows and secret-bearing collector values without retaining them', () => {
    expect(() => validateProviderBudgetEnvelope({ schemaVersion: PROVIDER_BUDGET_SCHEMA, source: { id: 'collector', kind: 'command', observedAt: '2026-09-02T00:00:00Z' }, providers: [{ providerId: 'claude', status: 'available', windows: [{ id: 'same', label: 'token=leak', usedPct: 1 }, { id: 'other', label: 'ok', usedPct: 2 }] }] })).toThrow(/invalid/);
  });
  it('holds stale snapshots and clears a drain after a reset snapshot', () => {
    expect(evaluateAdmission({ envelope: envelope(72, '2020-01-01T00:00:00Z'), bindings, policies, providerId: 'codex', model: 'gpt-5.6-terra', now: Date.now() }).action).toBe('hold_stale');
    expect(evaluateAdmission({ envelope: envelope(72), bindings, policies, providerId: 'claude', model: 'claude-sonnet-5' }).action).toBe('launch');
    expect(evaluateAdmission({ bindings: [{ ...bindings[0] }], policies: [{ ...policies[0], requiredPaidUnattended: true }], providerId: 'claude', model: 'claude-opus-5' }).action).toBe('hold_unknown');
  });
  it('deduplicates DRAIN/HARD_DRAIN within one reset episode and opens a new reset episode', () => {
    expect(providerBudgetEpisodeKey('workspace', 'claude', ['primary'], '2026-09-02T08:00:00Z')).toBe(providerBudgetEpisodeKey('workspace', 'claude', ['primary'], '2026-09-02T08:00:00Z'));
    expect(providerBudgetEpisodeKey('workspace', 'claude', ['primary'], '2026-09-02T08:00:00Z')).not.toBe(providerBudgetEpisodeKey('workspace', 'claude', ['primary'], '2026-09-02T13:00:00Z'));
  });
  it('keeps a successful provider when the independent scoped collector fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-codexbar-')); const script = path.join(dir, 'collector');
    await writeFile(script, `#!${process.execPath}\nif (process.argv.includes('claude')) process.stdout.write(JSON.stringify([{provider:'claude',usage:{updatedAt:'2026-09-02T00:00:00Z',primary:{usedPercent:15}}}])); else process.exit(2);\n`); await chmod(script, 0o755);
    const prior = process.env.ARCP_CODEXBAR_BIN; process.env.ARCP_CODEXBAR_BIN = script;
    try { const snapshot = await collectCodexbar(); expect(snapshot.providers).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'claude', status: 'available' }), expect.objectContaining({ providerId: 'codex', status: 'error', error: 'provider collector failed' })])); }
    finally { if (prior === undefined) delete process.env.ARCP_CODEXBAR_BIN; else process.env.ARCP_CODEXBAR_BIN = prior; }
  });
  it('reads a fresh redacted Pi/Grok cache but never admits its advisory estimate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-cache-')); const cache = path.join(dir, 'quota-cache.json'); const fresh = new Date().toISOString();
    await writeFile(cache, JSON.stringify({ version: 1, accounts: { 'private-account-key': { updatedAt: fresh, tier: 'SuperGrok', weekly: { creditUsagePercent: 0, billingPeriodEnd: '2026-09-06T01:21:00+08:00' }, monthly: { monthlyLimit: 100, used: 1, billingPeriodEnd: '2026-10-01T00:00:00+08:00' } } } }));
    const snapshot = await collectPiGrokCache({ id: 'pi-grok-cache', kind: 'pi-grok-cache', cachePath: cache, maxOutputBytes: 4096, maxAgeMs: 300_000 });
    expect(JSON.stringify(snapshot)).not.toContain('private-account-key'); expect(snapshot).toMatchObject({ source: { id: 'pi-grok-cache', kind: 'paseo', trust: 'advisory', estimated: true, automaticAdmissionEligible: false }, providers: [{ providerId: 'pi', sourceLabel: 'pi-grok-cli quota cache', windows: expect.arrayContaining([expect.objectContaining({ id: 'weekly', remainingPct: 100 })]) }] });
    expect(evaluateAdmission({ envelope: snapshot, bindings: [{ id: 'pi', providerId: 'pi', sourceId: 'pi-grok-cache', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }], policies, providerId: 'pi', model: 'grok-cli/grok-4.6' })).toMatchObject({ action: 'hold_unknown', reasons: ['provider budget source is not eligible for automatic admission'] });
  });
  it('admits Grok from an authoritative operator command envelope', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-grok-command-')); const script = path.join(dir, 'collector');
    await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({schemaVersion:'arcp.provider-budget/v1',source:{id:'operator-grok',kind:'command',observedAt:new Date().toISOString(),trust:'authoritative',estimated:false,automaticAdmissionEligible:true},providers:[{providerId:'pi',status:'available',windows:[{id:'weekly',label:'weekly',remainingPct:75}]}]}));\n`); await chmod(script, 0o755);
    const snapshot = await (await import('../../../skills/agent-runtime-control-panel/runtime/src/provider-budget.js')).runCommandCollector({ id: 'operator-grok', kind: 'command', trust: 'authoritative', estimated: false, automaticAdmissionEligible: true, command: [script] });
    expect(evaluateAdmission({ envelope: snapshot, bindings: [{ id: 'pi-grok', providerId: 'pi', sourceId: 'operator-grok', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }], policies, providerId: 'pi', model: 'grok-cli/grok-4.6' }).action).toBe('launch');
  });
  it('rejects a command collector whose envelope tries to disagree with configured trust', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-grok-command-mismatch-')); const script = path.join(dir, 'collector');
    await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({schemaVersion:'arcp.provider-budget/v1',source:{id:'operator-grok',kind:'command',observedAt:new Date().toISOString(),trust:'advisory',estimated:true,automaticAdmissionEligible:false},providers:[{providerId:'pi',status:'available',windows:[{id:'weekly',label:'weekly',remainingPct:75}]}]}));\n`); await chmod(script, 0o755);
    await expect((await import('../../../skills/agent-runtime-control-panel/runtime/src/provider-budget.js')).runCommandCollector({ id: 'operator-grok', kind: 'command', trust: 'authoritative', estimated: false, automaticAdmissionEligible: true, command: [script] })).rejects.toThrow(/disagrees/);
  });
  it('keeps unavailable CodexBar Grok unknown instead of treating it as zero', () => {
    const snapshot = validateProviderBudgetEnvelope({ schemaVersion: PROVIDER_BUDGET_SCHEMA, source: { id: 'local-codexbar', kind: 'command', observedAt: new Date().toISOString(), trust: 'authoritative', estimated: false, automaticAdmissionEligible: true }, providers: [{ providerId: 'pi', status: 'unavailable', windows: [], error: 'provider collector failed' }] });
    expect(evaluateAdmission({ envelope: snapshot, bindings: [{ id: 'pi-grok', providerId: 'pi', sourceId: 'local-codexbar', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }], policies, providerId: 'pi', model: 'grok-cli/grok-4.6' })).toMatchObject({ action: 'hold_unknown', reasons: ['provider budget is unavailable'] });
    expect(snapshot.providers[0].windows).toHaveLength(0);
  });
  it('keeps default Paseo-native Pi data advisory and settles an unqualified refresh on CodexBar', async () => {
    const native = translatePaseoProviderUsage('paseo-native', { fetchedAt: new Date().toISOString(), providers: [{ providerId: 'pi', status: 'available', windows: [{ id: 'weekly', label: 'weekly', remainingPct: 75 }] }] });
    expect(native.source).toMatchObject({ trust: 'advisory', estimated: true, automaticAdmissionEligible: false });
    expect(evaluateAdmission({ envelope: native, bindings: [{ id: 'pi-grok', providerId: 'pi', sourceId: 'paseo-native', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }], policies, providerId: 'pi', model: 'grok-cli/grok-4.6' }).action).toBe('hold_unknown');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-default-refresh-')); const config = path.join(dir, 'config.json'); const script = path.join(dir, 'codexbar');
    await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify([{provider:process.argv.includes('claude')?'claude':'codex',usage:{updatedAt:new Date().toISOString(),primary:{usedPercent:15},secondary:{usedPercent:25}}}]));\n`); await chmod(script, 0o755);
    await writeFile(config, JSON.stringify({ providerBudget: { sources: [{ id: 'paseo-native', kind: 'paseo', trust: 'advisory', estimated: true, automaticAdmissionEligible: false }, { id: 'local-codexbar', kind: 'codexbar', trust: 'authoritative', estimated: false, automaticAdmissionEligible: true }], policies, bindings } }));
    const oldConfig = process.env.ARCP_CONFIG, oldBin = process.env.ARCP_CODEXBAR_BIN; process.env.ARCP_CONFIG = config; process.env.ARCP_CODEXBAR_BIN = script;
    const service = new ArcpService(path.join(dir, 'state'), { run: async () => ({ value: [], stdout: '', stderr: '' }) } as any); await service.init();
    try { await expect(service.refreshProviderBudget()).resolves.toMatchObject({ status: 'ok', snapshot: { source: { id: 'local-codexbar', trust: 'authoritative', automaticAdmissionEligible: true } } }); }
    finally { service.close(); if (oldConfig === undefined) delete process.env.ARCP_CONFIG; else process.env.ARCP_CONFIG = oldConfig; if (oldBin === undefined) delete process.env.ARCP_CODEXBAR_BIN; else process.env.ARCP_CODEXBAR_BIN = oldBin; }
  });
  it('refuses stale or malformed Pi/Grok cache data', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-cache-invalid-')); const cache = path.join(dir, 'quota-cache.json');
    await writeFile(cache, JSON.stringify({ version: 1, accounts: { only: { updatedAt: '2020-01-01T00:00:00Z', weekly: { creditUsagePercent: 0, billingPeriodEnd: '2026-09-06T01:21:00+08:00' } } } }));
    await expect(collectPiGrokCache({ id: 'pi', kind: 'pi-grok-cache', cachePath: cache, maxAgeMs: 1 })).rejects.toThrow(/stale/);
    await writeFile(cache, JSON.stringify({ version: 1, accounts: { only: { updatedAt: '2099-01-01T00:00:00Z', weekly: { creditUsagePercent: 0, billingPeriodEnd: '2026-09-06T01:21:00+08:00' } } } })); await expect(collectPiGrokCache({ id: 'pi', kind: 'pi-grok-cache', cachePath: cache })).rejects.toThrow(/stale/);
    await writeFile(cache, '{"version":1,"accounts":[]}'); await expect(collectPiGrokCache({ id: 'pi', kind: 'pi-grok-cache', cachePath: cache })).rejects.toThrow();
  });
  it('refreshes the configured Pi source by id through the service seam', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-refresh-')); const cache = path.join(dir, 'quota-cache.json'); const config = path.join(dir, 'config.json');
    await writeFile(cache, JSON.stringify({ version: 1, accounts: { only: { updatedAt: new Date().toISOString(), tier: 'SuperGrok', weekly: { creditUsagePercent: 0, billingPeriodEnd: '2026-09-06T01:21:00+08:00' } } } }));
    await writeFile(config, JSON.stringify({ providerBudget: { sources: [{ id: 'pi-grok-cache', kind: 'pi-grok-cache', cachePath: '${ARCP_PI_GROK_CACHE}', maxOutputBytes: 4096, maxAgeMs: 300_000 }], policies, bindings: [{ id: 'pi', providerId: 'pi', sourceId: 'pi-grok-cache', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }] } }));
    const oldConfig = process.env.ARCP_CONFIG, oldCache = process.env.ARCP_PI_GROK_CACHE; process.env.ARCP_CONFIG = config; process.env.ARCP_PI_GROK_CACHE = cache;
    const cli = { run: async () => ({ value: [{ provider: 'pi', status: 'available', enabled: true, modes: [] }], stdout: '', stderr: '' }) }; const service = new ArcpService(path.join(dir, 'state'), cli as any); await service.init();
    try { await expect(service.refreshProviderBudget('pi-grok-cache')).resolves.toMatchObject({ status: 'ok', snapshot: { source: { trust: 'advisory', estimated: true, automaticAdmissionEligible: false }, providers: [expect.objectContaining({ providerId: 'pi' })] } }); expect(evaluateAdmission({ envelope: service.providerBudget(), bindings: [{ id: 'pi', providerId: 'pi', sourceId: 'pi-grok-cache', modelPatterns: ['grok-cli/grok-4.6'], windowIds: ['weekly'], admissionPolicyId: 'default' }], policies, providerId: 'pi', model: 'grok-cli/grok-4.6' }).action).toBe('hold_unknown'); }
    finally { service.close(); if (oldConfig === undefined) delete process.env.ARCP_CONFIG; else process.env.ARCP_CONFIG = oldConfig; if (oldCache === undefined) delete process.env.ARCP_PI_GROK_CACHE; else process.env.ARCP_PI_GROK_CACHE = oldCache; }
  });
});
