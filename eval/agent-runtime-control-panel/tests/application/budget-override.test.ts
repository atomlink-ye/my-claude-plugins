import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';

const policies = [{ id: 'default', maxAgeMs: 300_000, drainRemainingPct: 20, hardDrainRemainingPct: 10 }];
const bindings = [{ id: 'codex-weekly', providerId: 'codex', sourceId: 'operator', modelPatterns: ['gpt-5.6-terra'], windowIds: ['weekly'], admissionPolicyId: 'default' }];

class RecordingCli {
  launches: string[][] = [];
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto', 'full-access'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'worker-live', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium' }, stdout: '', stderr: '' };
    if (args[0] === 'run') { this.launches.push(args); return { value: { id: 'worker-live' }, stdout: '', stderr: '' }; }
    return { value: [], stdout: '', stderr: '' };
  }
}

const envKeys = ['ARCP_CONFIG', 'ARCP_CONFIRMATION_SECONDS'] as const;
const saved = new Map<string, string | undefined>();
afterEach(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } saved.clear(); });
const setEnv = (key: typeof envKeys[number], value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };

/** A service whose authoritative snapshot reports `remainingPct` capacity. */
async function fixture(remainingPct: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-budget-override-'));
  const script = path.join(dir, 'collector');
  await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({schemaVersion:'arcp.provider-budget/v1',source:{id:'operator',kind:'command',observedAt:new Date().toISOString(),trust:'authoritative',estimated:false,automaticAdmissionEligible:true},providers:[{providerId:'codex',status:'available',windows:[{id:'weekly',label:'weekly',remainingPct:${remainingPct}}]}]}));\n`);
  await chmod(script, 0o755);
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ providerBudget: { sources: [{ id: 'operator', kind: 'command', trust: 'authoritative', estimated: false, automaticAdmissionEligible: true, command: [script] }], policies, bindings } }));
  setEnv('ARCP_CONFIG', config);

  const cli = new RecordingCli();
  const service = new ArcpService(path.join(dir, 'state'), cli as any);
  await service.init();
  await service.refreshProviderBudget('operator');
  const { actor } = await service.registerActor({ clientIdentity: 'budget-owner' });
  const workspace = (await service.createWorkspace({ ownerActorId: actor.id, purpose: 'budget override' })).workspace;
  return { service, cli, actor, workspace, dir, script, config };
}

const intent = (actorId: string, workspaceId: string) => ({
  actorId, workspaceId, title: 'over-pace launch', profileId: 'codex-full-access',
  workspace: '/tmp', unattended: true,
} as any);

describe('Confirmed budget override — stage one returns a receipt, never a launch', () => {
  it('holds a DRAIN launch, and an override request returns a bounded risk receipt with an exact retry command and no side effects', async () => {
    const { service, cli, actor, workspace } = await fixture(15);

    const held: any = await service.startManaged(intent(actor.id, workspace.id));
    expect(held.launchable).toBe(false);
    expect(held.admission.action).toBe('drain');

    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship the campaign checkpoint tonight' });

    // The admission is unchanged: an override is a decision on top of a truthful
    // policy result, not a rewritten one.
    expect(receipt.admission.action).toBe('drain');
    expect(receipt.launchable).toBe(false);
    expect(typeof receipt.confirmation).toBe('string');
    expect(receipt.risk).toMatchObject({ admissionAction: 'drain', providerId: 'codex', model: 'gpt-5.6-terra', activeReservations: 0 });
    expect(receipt.risk.windows).toEqual([expect.objectContaining({ id: 'weekly', remainingPct: 15 })]);
    expect(receipt.recommendedCommands[0]).toContain(`--confirm ${receipt.confirmation}`);
    expect(receipt.reason).toBe('ship the campaign checkpoint tonight');

    // Nothing was created and no provider call was made.
    expect(service.state().goals).toHaveLength(0);
    expect(service.state().tasks).toHaveLength(0);
    expect(service.state().sessions).toHaveLength(0);
    expect(cli.launches).toHaveLength(0);
    service.close();
  });

  it('refuses an override request with no reason', async () => {
    const { service, actor, workspace } = await fixture(15);
    await expect(service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: '   ' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'overrideReason' });
    expect(service.state().goals).toHaveLength(0);
    service.close();
  });

  it('refuses an override when capacity is not draining, so the verb cannot become a routine bypass', async () => {
    const { service, actor, workspace } = await fixture(90);
    await expect(service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'no need' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'requestBudgetOverride' });
    service.close();
  });
});

describe('Confirmed budget override — stage two revalidates before launching', () => {
  it('launches the identical intent through ARCP and records the original admission alongside the Owner override', async () => {
    const { service, cli, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship tonight' });

    const started: any = await service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'ship tonight' });

    expect(started.session.state).not.toBeUndefined();
    expect(cli.launches).toHaveLength(1);
    // Requirement 6: the receipt keeps the admission that actually governed the
    // launch, plus the Owner's reason and evidence and the effective settings.
    expect(started.admission.action).toBe('drain');
    expect(started.budgetOverride).toMatchObject({
      confirmedByActorId: actor.id, reason: 'ship tonight', admissionAction: 'drain',
      effectiveLaunch: { profileId: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra' },
    });
    expect(started.budgetOverride.evidence).toMatchObject({ providerId: 'codex', snapshotSourceId: 'operator' });
    service.close();
  });

  it('refuses a replay of an already-used token', async () => {
    const { service, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'once' });
    await service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'once' });

    await expect(service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'once' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    expect(service.state().goals).toHaveLength(1);
    service.close();
  });

  it('refuses a changed intent, so a token minted for one launch cannot authorize another', async () => {
    const { service, cli, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });

    await expect(service.startManaged({ ...intent(actor.id, workspace.id), title: 'a different goal', budgetConfirmation: receipt.confirmation, overrideReason: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    expect(cli.launches).toHaveLength(0);
    expect(service.state().goals).toHaveLength(0);
    service.close();
  });

  it('refuses a different actor presenting the token', async () => {
    const { service, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });
    const other = (await service.registerActor({ clientIdentity: 'other-owner' })).actor;

    await expect(service.startManaged({ ...intent(actor.id, workspace.id), actorId: other.id, budgetConfirmation: receipt.confirmation, overrideReason: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    service.close();
  });

  it('refuses an expired token', async () => {
    setEnv('ARCP_CONFIRMATION_SECONDS', '-1');
    const { service, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });

    await expect(service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    service.close();
  });

  it('refuses when the quota snapshot moved between request and retry, since the Owner signed off on specific numbers', async () => {
    const { service, actor, workspace, script } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });

    // Capacity drops further; still draining, but not the figures confirmed.
    await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({schemaVersion:'arcp.provider-budget/v1',source:{id:'operator',kind:'command',observedAt:new Date().toISOString(),trust:'authoritative',estimated:false,automaticAdmissionEligible:true},providers:[{providerId:'codex',status:'available',windows:[{id:'weekly',label:'weekly',remainingPct:4}]}]}));\n`);
    await chmod(script, 0o755);
    await service.refreshProviderBudget('operator');

    await expect(service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    expect(service.state().goals).toHaveLength(0);
    service.close();
  });

  it('refuses a confirmation of another kind, keeping elevation, cache reheat and budget override separate', async () => {
    const { service, actor, workspace } = await fixture(15);
    // A syntactically valid token that was never minted as a budget override.
    await expect(service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: 'not-a-budget-override-token', overrideReason: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    service.close();
  });

  it('refuses requesting and confirming in the same call', async () => {
    const { service, actor, workspace } = await fixture(15);
    await expect(service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship', budgetConfirmation: 'token' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'budgetConfirmation' });
    service.close();
  });
});

describe('Confirmed budget override — lifts only the budget hold', () => {
  it('still refuses a launch whose settings are not live-validated, even holding a valid confirmation', async () => {
    const { service, cli, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });

    // Same confirmed intent, but the launch itself is threaded straight through
    // with a model the provider never validated. The override was minted against
    // the budget verdict and must not excuse this.
    await expect(service.launch({
      actorId: actor.id, goalId: (await service.createGoal({ actorId: actor.id, title: 'unvalidated', workspaceId: workspace.id } as any)).id,
      workspaceId: workspace.id, workspace: '/tmp', provider: 'codex', model: 'model-that-does-not-exist',
      budgetOverrideConfirmed: true,
    } as any)).rejects.toMatchObject({ code: 'profile_unavailable' });

    expect(cli.launches).toHaveLength(0);
    expect(receipt.admission.action).toBe('drain');
    service.close();
  });
});

describe('Confirmed budget override — receipts never leak secrets', () => {
  it('exposes no token hash, intent hash, snapshot hash or credential in the receipt or the launch result', async () => {
    const { service, actor, workspace } = await fixture(15);
    const receipt: any = await service.startManaged({ ...intent(actor.id, workspace.id), requestBudgetOverride: true, overrideReason: 'ship' });
    const started: any = await service.startManaged({ ...intent(actor.id, workspace.id), budgetConfirmation: receipt.confirmation, overrideReason: 'ship' });

    const stored = service.state().confirmations;
    for (const payload of [JSON.stringify(receipt), JSON.stringify({ ...started, credential: undefined })]) {
      expect(payload).not.toContain('tokenHash');
      expect(payload).not.toContain('intentHash');
      expect(payload).not.toContain('snapshotHash');
      for (const record of stored) expect(payload).not.toContain(record.tokenHash);
    }
    service.close();
  });
});
