import { mkdir, mkdtemp, readdir, rename, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService, ArcpStore, type State } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { analysisBrief, CodexRuntimeAnalyst, WorkspaceSteward, stewardViewOf, type StewardAnalyst, type StewardDossier } from '../../../skills/agent-runtime-control-panel/runtime/src/steward.js';
import { evaluateSupervision, supervisionPolicyId, type SupervisionView } from '../../../skills/agent-runtime-control-panel/runtime/src/supervision.js';

class DiscoveryCli {
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto', 'full-access'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: args[1], status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium' }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}

async function serviceAt(root: string) {
  const service = new ArcpService(root, new DiscoveryCli() as any);
  await service.init();
  return service;
}

async function workspaceAt(service: ArcpService) {
  const { actor } = await service.registerActor({ clientIdentity: `convergence-${Math.random()}` });
  const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'convergence proof' });
  return { actor, workspace: created.workspace };
}

describe('Round-3 convergence proofs', () => {
  it('defaults supervision to the owner-selected non-prompting Codex full-access profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-default-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const policy = await service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 1_000 });
    expect(policy.stewardProfileId).toBe('codex-full-access');
    service.close();
  });

  it.each(['codex-worker', 'claude-manager', 'pi-grok-worker'] as const)('rejects prompting or non-Codex Steward profile %s', async (profileId) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-profile-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    await expect(service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 1_000, stewardProfileId: profileId })).rejects.toMatchObject({ code: 'invalid_request', field: 'stewardProfileId' });
    service.close();
  });

  it.each([
    { ownerRole: 'steward', expected: 0 },
    { ownerRole: 'steward-analyst', expected: 0 },
    { ownerRole: 'worker', expected: 1 },
  ])('uses the owner role as the supervision exclusion key ($ownerRole)', ({ ownerRole, expected }) => {
    const view: SupervisionView = {
      subjects: [{ id: 'task-1', workspaceId: 'workspace-1', ownerRole, generation: 1, lifecycle: 'claimed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      results: [], knowledge: [], events: [], signals: [],
      policies: [{ id: supervisionPolicyId('workspace-1'), workspaceId: 'workspace-1', inactivityAfterMs: 1, cooldownMs: 100, stewardProfileId: 'codex-full-access', automatic: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      reviews: [],
    };
    expect(evaluateSupervision(view, Date.parse('2026-01-01T00:00:01.000Z'))).toHaveLength(expected);
  });

  it.each([
    'reason: delayed dependency',
    'reason=delayed dependency',
    'The transcript summary is safe prose about a meeting.',
    'The assistant integration is healthy.',
  ])('accepts safe prose that is not a transcript structure: %s', async (summary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-prose-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    await expect(service.publishChannelEvent({ workspaceId: workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary, evidenceRefs: [], notify: false })).resolves.toMatchObject({ kind: 'finding' });
    service.close();
  });

  it.each(['<thinking>hidden chain</thinking>', '<assistant>private</assistant>', 'chain-of-thought: hidden', 'internal reasoning: hidden', '\nassistant: private'])('rejects actual transcript leak shape: %s', async (summary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-leak-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    await expect(service.publishChannelEvent({ workspaceId: workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary, evidenceRefs: [], notify: false })).rejects.toMatchObject({ code: 'invalid_request' });
    service.close();
  });

  it('does not write a Steward report when the bounded analyst times out without a cited Result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-timeout-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const stewardMember = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'product task' });
    const analyst: StewardAnalyst = { profileId: 'codex-full-access', async analyze(): Promise<any> { return { provider: 'codex', model: 'gpt-5.6-terra', cited: false }; } };
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, { workspaceId: workspace.id, stewardProfileId: 'codex-full-access', stewardMemberId: stewardMember.member.id, cooldownMs: 1, automatic: true, manualProgressWindowMs: 1 });
    const outcome = await steward.onSupervisionBreach({ workspaceId: workspace.id, subjectTaskId: task.id, generation: 0, reason: 'inactivity_budget', progressSince: new Date(0).toISOString(), observedAt: new Date().toISOString() });
    expect(outcome.status).toBe('timeout');
    expect(steward.reports(workspace.id)).toHaveLength(0);
    service.close();
  });

  it('uses one execution path for automatic and manual requests even when the first report exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-one-path-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const stewardMember = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] });
    const owner = service.state().members.find((member) => member.workspaceId === workspace.id && member.role === 'owner')!;
    const task = await service.createTask({ workspaceId: workspace.id, title: 'product task' }); const entered: string[] = [];
    const analyst: StewardAnalyst = { profileId: 'codex-full-access', async analyze(dossier: StewardDossier) { entered.push(dossier.request.trigger); return { provider: 'codex', model: 'gpt-5.6-terra', narrative: 'bounded finding' }; } };
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, { workspaceId: workspace.id, stewardProfileId: 'codex-full-access', stewardMemberId: stewardMember.member.id, cooldownMs: 1, automatic: true, manualProgressWindowMs: 1 });
    expect((await steward.onSupervisionBreach({ workspaceId: workspace.id, subjectTaskId: task.id, generation: 0, reason: 'inactivity_budget', progressSince: new Date(0).toISOString(), observedAt: new Date().toISOString() })).status).toBe('analyzed');
    expect((await steward.requestAnalysis({ workspaceId: workspace.id, subjectTaskId: task.id, requestedByMemberId: owner.id })).status).toBe('deduplicated');
    expect(entered).toEqual(['automatic']);
    service.close();
  });

  it('runs the automatic breach through WorkspaceSteward and persists one cited report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-automatic-steward-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const worker = await service.joinWorkspace({ workspaceId: workspace.id, label: 'worker', role: 'worker' });
    const stewardMember = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'stalled product task' });
    await service.claimTask(task.id, worker.member.id, 0);
    const stale = '2026-01-01T00:00:00.000Z';
    await service.store.mutate((state: State) => { const item = state.tasks.find((value) => value.id === task.id)!; item.createdAt = stale; item.updatedAt = stale; });
    const entered: string[] = []; let brief = '';
    const analyst: StewardAnalyst = { profileId: 'codex-full-access', async analyze(dossier: StewardDossier) { entered.push(dossier.request.trigger); brief = analysisBrief(dossier); return { provider: 'codex', model: 'gpt-5.6-terra', narrative: 'stalled task is ready for steering', cited: true, evidenceRefs: [dossier.subject.id] }; } };
    service.setStewardFactory(async (ownedService, workspaceId) => new WorkspaceSteward(stewardViewOf(ownedService), analyst, { workspaceId, stewardProfileId: 'codex-full-access', stewardMemberId: stewardMember.member.id, cooldownMs: 60_000, automatic: true, manualProgressWindowMs: 60_000 }));
    await service.configureSupervision({ workspaceId: workspace.id, inactivityAfterMs: 1_000, cooldownMs: 60_000 });
    const reviews = await service.evaluateSupervision(Date.now() + 3_600_000);
    expect(reviews).toHaveLength(1);
    expect(entered).toEqual(['automatic']);
    expect(brief).toContain(process.execPath);
    expect(brief).toContain('skills/agent-runtime-control-panel/scripts/arcp');
    expect(brief).toContain('workspace');
    expect(brief).toContain('task');
    expect(brief).toContain('result');
    expect(brief).toContain('--evidence');
    expect(service.state().knowledge.filter((entry) => entry.tags.includes('workspace-steward'))).toHaveLength(1);
    expect(service.state().knowledge.at(-1)?.text).toContain('stalled task is ready for steering');
    service.close();
  });

  it('refuses Steward credentials on product Tasks but permits a bounded analysis Task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-scope-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const steward = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] });
    const product = await service.createTask({ workspaceId: workspace.id, title: 'product task' });
    await expect(service.claimTask(product.id, steward.member.id, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    await service.store.mutate((state: State) => { const task = state.tasks.find((item) => item.id === product.id)!; task.ownerMemberId = steward.member.id; task.fence = 1; task.lifecycle = 'claimed'; });
    await expect(service.submitResult({ workspaceId: workspace.id, taskId: product.id, memberId: steward.member.id, status: 'candidate', summary: 'product mutation', expectedFence: 1 })).rejects.toMatchObject({ code: 'unauthorized' });
    const analysisMember = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward analyst', role: 'steward-analyst', capabilities: ['claim_task', 'submit_result', 'read_context', 'write_knowledge'] });
    const analysis = await service.createTask({ workspaceId: workspace.id, title: 'bounded analysis', scope: 'steward_analysis' });
    await expect(service.claimTask(analysis.id, analysisMember.member.id, 0)).resolves.toMatchObject({ scope: 'steward_analysis' });
    await expect(service.submitResult({ workspaceId: workspace.id, taskId: analysis.id, memberId: analysisMember.member.id, status: 'candidate', summary: 'cited analysis', evidenceRefs: [product.id], expectedFence: 1 })).resolves.toMatchObject({ taskId: analysis.id });
    service.close();
  });

  it('rolls back a failed ArcpStore write so a Result source id can be retried', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-rollback-')); const store = new ArcpStore(root); await store.init(); await store.mutate(() => undefined);
    const result = { id: 'result-retry', workspaceId: 'workspace-1', taskId: 'task-1', memberId: 'member-1', fence: 1, status: 'candidate' as const, summary: 'retryable result', evidenceRefs: ['task-1'], sourceId: 'source-retry', createdAt: new Date().toISOString() };
    const original = store.file; const backup = `${original}.backup`;
    await rename(original, backup); await mkdir(original);
    await expect(store.mutate((state: State) => { state.results.push(result); })).rejects.toThrow();
    expect(store.snapshot().results).toHaveLength(0);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    await rmdir(original); await rename(backup, original);
    await expect(store.mutate((state: State) => { state.results.push(result); })).resolves.toBeUndefined();
    expect(store.snapshot().results).toContainEqual(result);
  });

  it('enforces an explicit empty capability set for a non-Steward member', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-capability-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const member = await service.joinWorkspace({ workspaceId: workspace.id, label: 'restricted', role: 'worker', capabilities: [] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'restricted task' });
    await expect(service.claimTask(task.id, member.member.id, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    service.close();
  });

  it('does not let a Steward analyst claim a product task even with analysis capabilities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-analyst-scope-'));
    const service = await serviceAt(root); const { workspace } = await workspaceAt(service);
    const member = await service.joinWorkspace({ workspaceId: workspace.id, label: 'steward analyst', role: 'steward-analyst', capabilities: ['claim_task', 'submit_result'] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'product task' });
    await expect(service.claimTask(task.id, member.member.id, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    service.close();
  });

  it('keeps the role exclusion fail-closed when no owner role is present', () => {
    const view: SupervisionView = {
      subjects: [{ id: 'task-legacy', workspaceId: 'workspace-1', generation: 1, lifecycle: 'claimed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      results: [], knowledge: [], events: [], signals: [],
      policies: [{ id: 'policy-legacy', workspaceId: 'workspace-1', inactivityAfterMs: 1, cooldownMs: 100, stewardProfileId: 'codex-full-access', automatic: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], reviews: [],
    };
    expect(evaluateSupervision(view, Date.parse('2026-01-01T00:00:01.000Z'))).toHaveLength(1);
  });

  it('round-trips the retried Result after the failed write is repaired', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-reopen-')); const store = new ArcpStore(root); await store.init();
    const result = { id: 'result-reopen', workspaceId: 'workspace-1', taskId: 'task-1', memberId: 'member-1', fence: 1, status: 'candidate' as const, summary: 'durable retry', evidenceRefs: ['task-1'], sourceId: 'source-reopen', createdAt: new Date().toISOString() };
    await store.mutate((state: State) => { state.results.push(result); });
    const reopened = new ArcpStore(root); await reopened.init();
    expect(reopened.snapshot().results).toContainEqual(result);
  });

  it.each([false, true])('accepts only a cited Result authored by the launched Steward member (matching=%s)', async (matching) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-convergence-provenance-'));
    const service = await serviceAt(root); const { actor, workspace } = await workspaceAt(service);
    const impostor = await service.joinWorkspace({ workspaceId: workspace.id, label: 'impostor', role: 'worker' });
    const subject = await service.createTask({ workspaceId: workspace.id, title: 'product task' });
    const originalStartManaged = service.startManaged.bind(service);
    (service as any).startManaged = async (input: any) => {
      const started = await originalStartManaged(input);
      const authorMemberId = matching ? started.member.id : impostor.member.id;
      if (matching) await service.claimTask(started.task.id, authorMemberId, 0);
      else await service.store.mutate((state: State) => { const task = state.tasks.find((item) => item.id === started.task.id)!; task.ownerMemberId = authorMemberId; task.fence = 1; task.lifecycle = 'claimed'; });
      await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: authorMemberId, status: 'candidate', summary: 'cited Steward analysis', evidenceRefs: [subject.id], expectedFence: 1 });
      return started;
    };
    const analyst = new CodexRuntimeAnalyst(service, { profileId: 'codex-worker', actorId: actor.id, waitMs: 0, pollMs: 1 });
    const dossier = { key: 'provenance-check', workspace, subject, materialProgress: { refs: [] }, evidenceRefs: [subject.id], classification: 'STUCK', recommendation: 'STEER', why: 'no progress', request: { trigger: 'automatic', workspaceId: workspace.id, subjectTaskId: subject.id, generation: 0, progressSince: new Date(0).toISOString(), requestedAt: new Date().toISOString() } } as unknown as StewardDossier;
    const narrative = await analyst.analyze(dossier);
    expect(narrative.cited).toBe(matching);
    expect(narrative.narrative).toBe(matching ? 'cited Steward analysis' : undefined);
    service.close();
  });
});
