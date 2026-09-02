import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { SQLiteStateStore } from '../../../../skills/agent-runtime-control-panel/runtime/src/state-store.js';
import { PROVIDER_BUDGET_SCHEMA, validateProviderBudgetEnvelope } from '../../../../skills/agent-runtime-control-panel/runtime/src/provider-budget.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

const configPath = fileURLToPath(new URL('../../../../skills/agent-runtime-control-panel/config/default.json', import.meta.url));
const freshBudget = () => validateProviderBudgetEnvelope({
  schemaVersion: PROVIDER_BUDGET_SCHEMA,
  source: { id: 'local-codexbar', kind: 'command', observedAt: new Date().toISOString(), trust: 'authoritative', estimated: false, automaticAdmissionEligible: true },
  providers: [
    { providerId: 'claude', status: 'available', windows: [{ id: 'primary', label: 'five-hour', usedPct: 30 }] },
    { providerId: 'codex', status: 'available', windows: [{ id: 'secondary', label: 'weekly', usedPct: 30 }] },
  ],
});

describe('routing guidance and provider selection receipts', () => {
  it('returns operator guidance verbatim, records the exact receipt, and preserves it through SQLite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-receipt-')); const store = new SQLiteStateStore(root); const cli = new FakePaseoCli({ providers: ['codex'] }); const service = new ArcpService(root, cli as any, store); await service.init();
    const guidance = JSON.parse(await readFile(configPath, 'utf8')).routing.guidance;
    (service as any).providerBudgetSnapshot = freshBudget();
    const preflight = await service.preflight({ profileId: 'codex-worker' });
    expect(preflight.routingGuidance).toBe(guidance);
    expect(Object.keys(preflight.selectionReceipt).sort()).toEqual(['chosenRole', 'mode', 'model', 'provider', 'quotaSnapshot', 'reason', 'thinking']);
    expect(preflight.selectionReceipt).toMatchObject({ chosenRole: 'worker', provider: 'codex', model: 'gpt-5.6-terra', thinking: 'medium', mode: 'auto', quotaSnapshot: { source: { id: 'local-codexbar' } } });
    const { actor } = await service.registerActor({ clientIdentity: 'routing-receipt-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'persist routing receipt' });
    const launched = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect(launched.selectionReceipt).toEqual(preflight.selectionReceipt);
    const db = new DatabaseSync(store.file); expect(db.prepare('SELECT chosen_role, provider, model, thinking, mode FROM selection_receipts WHERE runtime_id = ?').get(launched.id)).toEqual({ chosen_role: 'worker', provider: 'codex', model: 'gpt-5.6-terra', thinking: 'medium', mode: 'auto' }); db.close(); service.close();
    const restarted = new ArcpService(root, new FakePaseoCli({ providers: ['codex'] }) as any, new SQLiteStateStore(root)); await restarted.init();
    expect(restarted.state().sessions.find((item) => item.id === launched.id)?.selectionReceipt).toEqual(preflight.selectionReceipt); restarted.close();
  });

  it('returns routing guidance and the same receipt from managed start before exposing the session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-start-')); const { service } = await createControl(root, { cli: new FakePaseoCli({ providers: ['codex'] }) }); const { actor } = await service.registerActor({ clientIdentity: 'routing-start-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'routing start' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'routing start', profileId: 'codex-worker' }) as Exclude<Awaited<ReturnType<ArcpService['startManaged']>>, { action: string }>;
    expect(started.routingGuidance).toBe(JSON.parse(await readFile(configPath, 'utf8')).routing.guidance);
    expect(started.selectionReceipt).toEqual(started.session.selectionReceipt); service.close();
  });

  it('offers the provider-specific Codex permission ladder without silently elevating', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-ladder-')); const { service } = await createControl(root, { cli: new FakePaseoCli({ providers: ['codex'], modeListing: ['auto', 'auto-review', 'full-access'] }) }); (service as any).providerBudgetSnapshot = freshBudget();
    const preflight = await service.preflight({ profileId: 'codex-worker', unattended: true });
    expect(preflight).toMatchObject({ action: 'hold', launchable: false, recommendedCommands: [expect.stringContaining('--profile codex-auto-review'), expect.stringContaining('--profile codex-full-access')] });
    service.close();
  });

  it('uses the distinct Claude permission vocabulary for its ladder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-claude-ladder-')); const { service } = await createControl(root, { cli: new FakePaseoCli({ providers: ['claude'], modeListing: ['auto', 'bypassPermissions'] }) }); (service as any).providerBudgetSnapshot = freshBudget();
    const claudeLadder = await service.preflight({ profileId: 'claude-manager', unattended: true });
    // The complete list matters: an extra entry here is how a cross-role or
    // cross-price suggestion sneaks in unnoticed.
    expect(claudeLadder).toMatchObject({ action: 'hold', launchable: false, recommendedCommands: [expect.stringContaining('--profile claude-bypass-permissions')] });
    for (const command of claudeLadder.recommendedCommands) expect(command).not.toMatch(/auto-review|full-access|codex/);
    service.close();
  });

  it('offers an unattended Claude worker a worker-role profile rather than only a manager one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-claude-worker-')); const { service } = await createControl(root, { cli: new FakePaseoCli({ providers: ['claude'], modeListing: ['auto', 'bypassPermissions'] }) }); (service as any).providerBudgetSnapshot = freshBudget();
    // Role is intent. Holding an unattended worker and then offering only the
    // Opus manager profile would push the caller across both a role boundary
    // and a price tier to satisfy a permission requirement.
    const preflight = await service.preflight({ profileId: 'claude-sonnet-worker', unattended: true });
    // Exactly one offer, and it changes only the permission mode: same role,
    // same model, never the Opus manager profile.
    expect(preflight).toMatchObject({ action: 'hold', launchable: false, recommendedCommands: [expect.stringContaining('--profile claude-sonnet-worker-bypass')] });
    expect(preflight.selectionReceipt.model).toBe('claude-sonnet-5');
    service.close();
  });

  it('documents every configured launch profile in the skill README', async () => {
    // The README presents its table as the source of the named profiles, so a
    // profile added to config without a row there is a documentation lie.
    const readmePath = fileURLToPath(new URL('../../../../skills/agent-runtime-control-panel/README.md', import.meta.url));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const readme = await readFile(readmePath, 'utf8');
    const documented = new Set([...readme.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((match) => match[1]));
    expect(config.profiles.map((profile: any) => profile.id).filter((id: string) => !documented.has(id))).toEqual([]);
  });

  it('binds every configured profile model to a provider-budget rule', async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    for (const profile of config.profiles) expect(config.providerBudget.bindings.some((binding: any) => binding.providerId === profile.provider && binding.modelPatterns.includes(profile.model))).toBe(true);
  });
});
