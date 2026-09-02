import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import type { RuntimeSession, State } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { handleArcp, stewardFor } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp-server.js';
import {
  CodexRuntimeAnalyst,
  WorkspaceSteward,
  analysisKeyOf,
  stewardViewOf,
  STEWARD_REPORT_TAG,
} from '../../../skills/agent-runtime-control-panel/runtime/src/steward.js';
import type {
  StewardAnalysisRequest,
  StewardAnalyst,
  StewardDossier,
  StewardNarrative,
  StewardPolicy,
  SupervisionBreach,
} from '../../../skills/agent-runtime-control-panel/runtime/src/steward.js';

/**
 * A Paseo CLI that reports a live Codex provider and echoes back a runtime that
 * matches the launched profile exactly. `inspect` deliberately reports
 * `status=running` with `lastTurnState=running` for every session, because that
 * is what a live stalled runtime records and it is indistinguishable from a
 * healthy one.
 */
class FakeCli {
  lastLaunchArgs: string[] = [];
  launches = 0;
  stops = 0;
  constructor(private readonly providers: string[] = ['codex']) {}
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: this.providers.map((provider) => ({ provider, status: 'available', enabled: true, modes: ['auto', 'full-access'] })), stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'run') { this.launches += 1; this.lastLaunchArgs = args; return { value: { id: `paseo-session-${this.launches}` }, stdout: '', stderr: '' }; }
    if (args[0] === 'ls') return { value: [{ id: 'paseo-session-1', status: 'running' }], stdout: '', stderr: '' };
    if (args[0] === 'stop') { this.stops += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') {
      if (String(args[1]).includes('lost')) throw new Error('paseo inspect timed out');
      return { value: { id: args[1], status: 'running', lastTurnState: 'running', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    }
    return { value: [], stdout: '', stderr: '' };
  }
}

class RecordingAnalyst implements StewardAnalyst {
  readonly profileId = 'codex-worker';
  calls: StewardDossier[] = [];
  constructor(private readonly narrative: StewardNarrative = { narrative: 'codex narrative', provider: 'codex', model: 'gpt-5.6-terra', thinking: 'medium' }) {}
  async analyze(dossier: StewardDossier): Promise<StewardNarrative> { this.calls.push(dossier); return this.narrative; }
}

class RefusingAnalyst implements StewardAnalyst {
  readonly profileId = 'codex-worker';
  calls = 0;
  async analyze(): Promise<StewardNarrative> { this.calls += 1; throw Object.assign(new Error('codex is not live'), { code: 'steward_provider_unavailable' }); }
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function control(root: string, cli = new FakeCli()) {
  const service = new ArcpService(root, cli as any);
  await service.init();
  return service;
}

/** One Workspace, one owner, one Steward member, one subject Task and one live runtime. */
async function seed(service: ArcpService, options: { taskTitle?: string } = {}) {
  const { actor } = await service.registerActor({ clientIdentity: `steward-owner-${Math.random()}` });
  const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'steward proof' });
  const workspaceId = created.workspace.id;
  const steward = await service.joinWorkspace({ workspaceId, label: 'workspace-steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] });
  const worker = await service.joinWorkspace({ workspaceId, label: 'worker', role: 'worker', capabilities: [] });
  const goal = await service.createGoal({ actorId: actor.id, title: options.taskTitle ?? 'subject goal', workspaceId });
  const task = await service.createTask({ workspaceId, title: options.taskTitle ?? 'subject work' });
  const binding = service.state().bindings.find((item) => item.actorId === actor.id)!;
  const session: RuntimeSession = {
    id: `runtime_subject_${task.id.slice(-8)}`, actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1,
    runtimeKind: 'paseo', adapterId: 'paseo', workspaceId, memberId: worker.member.id, profileId: 'codex-worker',
    provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium',
    externalId: `paseo-subject-${task.id.slice(-8)}`, state: 'running', lastTurnState: 'running', createdAt: iso(-3_600_000),
  };
  await service.store.mutate((state: State) => { state.sessions.push(session); });
  return { actor, workspaceId, owner: created.member, ownerCredential: created.credential, stewardMember: steward.member, worker: worker.member, task, session };
}

function policyFor(workspaceId: string, stewardMemberId: string, overrides: Partial<StewardPolicy> = {}): StewardPolicy {
  return { workspaceId, stewardProfileId: 'codex-worker', stewardMemberId, cooldownMs: 900_000, automatic: true, manualProgressWindowMs: 60_000, ...overrides };
}

const breachFor = (workspaceId: string, subjectTaskId: string, generation: number, overrides: Partial<SupervisionBreach> = {}): SupervisionBreach => ({
  workspaceId, subjectTaskId, generation, reason: 'inactivity_budget', progressSince: iso(-60_000), observedAt: iso(0), ...overrides,
});

/** Backdate a durable row so "before the progress window" is a real, not simulated, fact. */
async function backdateKnowledge(service: ArcpService, knowledgeId: string, at: string) {
  await service.store.mutate((state: State) => { state.knowledge.find((item) => item.id === knowledgeId)!.createdAt = at; });
}

describe('Workspace Steward — documented contract', () => {
  it('teaches the Steward commands and the non-goals a reader must not violate', async () => {
    // Catches: shipping the Steward without telling an agent how to reach it,
    // and catches quietly dropping the read-only / no-substitution contract.
    const text = await readFile(path.join(process.cwd(), '../llms.txt'), 'utf8');
    expect(text).toContain('arcp steward analyze WORKSPACE --task TASK');
    expect(text).toContain('arcp steward reports WORKSPACE');
    expect(text).toContain('never from liveness');
    expect(text).toContain('there is no always-on Steward process');
  });
});

describe('Workspace Steward — one execution path, two triggers', () => {
  it('routes the automatic breach and the manual member request through the same execution path and the same durable analysis', async () => {
    // Catches: giving `requestAnalysis` its own inline implementation, or
    // dropping the durable dedupe, so the manual trigger mints a second report.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-onepath-'));
    const service = await control(root);
    const { workspaceId, owner, stewardMember, task } = await seed(service);
    const analyst = new RecordingAnalyst();
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, policyFor(workspaceId, stewardMember.id));
    const entered: StewardAnalysisRequest[] = [];
    steward.onExecution((request) => entered.push(request));

    const automatic = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    const manual = await steward.requestAnalysis({ workspaceId, subjectTaskId: task.id, requestedByMemberId: owner.id });

    expect(entered.map((request) => request.trigger)).toEqual(['automatic', 'manual']);
    expect(entered.every((request) => request.subjectTaskId === task.id && request.workspaceId === workspaceId)).toBe(true);
    expect(automatic.status).toBe('analyzed');
    expect(manual.status).toBe('deduplicated');
    expect(manual.knowledgeId).toBe(automatic.knowledgeId);
    expect(manual.key).toBe(automatic.key);
    expect(manual.key).toBe(analysisKeyOf(workspaceId, task.id, task.fence));
    expect(analyst.calls).toHaveLength(1);
    expect(steward.reports(workspaceId)).toHaveLength(1);
    service.close();
  });

  it('produces exactly one analysis, one report and one channel event for repeated automatic breaches', async () => {
    // Catches: removing the per-subject-generation dedupe, or publishing the
    // manager notification with a non-deterministic id, so repeated timer ticks
    // fan out into repeated analyses.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-dedupe-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task } = await seed(service);
    const analyst = new RecordingAnalyst();
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, policyFor(workspaceId, stewardMember.id));

    const first = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    const second = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    const third = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));

    expect([first.status, second.status, third.status]).toEqual(['analyzed', 'deduplicated', 'deduplicated']);
    expect(analyst.calls).toHaveLength(1);
    const state = service.state();
    expect(state.knowledge.filter((entry) => entry.tags.includes(STEWARD_REPORT_TAG))).toHaveLength(1);
    expect(state.channelEvents.filter((event) => event.id === first.eventId)).toHaveLength(1);
    expect([second.eventId, third.eventId]).toEqual([first.eventId, first.eventId]);
    service.close();
  });

  it('keeps the completed report readable after an ARCP restart and still refuses a duplicate analysis', async () => {
    // Catches: holding the dedupe index in memory instead of in durable state,
    // which would let a restart re-run the analysis and mint a second report.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-restart-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task } = await seed(service);
    const analyst = new RecordingAnalyst();
    const before = await new WorkspaceSteward(stewardViewOf(service), analyst, policyFor(workspaceId, stewardMember.id))
      .onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    expect(before.status).toBe('analyzed');
    service.close();

    const restarted = await control(root);
    const afterAnalyst = new RecordingAnalyst();
    const steward = new WorkspaceSteward(stewardViewOf(restarted), afterAnalyst, policyFor(workspaceId, stewardMember.id));
    const reports = steward.reports(workspaceId);
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe(before.knowledgeId);
    expect(reports[0].classification).toBe(before.classification);
    expect(reports[0].recommendation).toBe(before.recommendation);
    const repeat = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    expect(repeat.status).toBe('deduplicated');
    expect(repeat.knowledgeId).toBe(before.knowledgeId);
    expect(afterAnalyst.calls).toHaveLength(0);
    expect(steward.reports(workspaceId)).toHaveLength(1);
    restarted.close();
  });
});

describe('Workspace Steward — classification from durable progress, not liveness', () => {
  it('separates STUCK from HEALTHY for two runtimes whose live state and lastTurnState are identical', async () => {
    // Catches: deriving STUCK from session.state / lastTurnState / observation
    // liveness. Both runtimes below report running/running, so any
    // liveness-derived classifier gives them the same answer.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-trap-'));
    const service = await control(root);
    const healthy = await seed(service, { taskTitle: 'healthy subject' });
    const stuck = await seed(service, { taskTitle: 'stuck subject' });

    const fresh = await service.addKnowledge({ workspaceId: healthy.workspaceId, authorMemberId: healthy.worker.id, kind: 'learning', text: 'shipped a durable step', taskId: healthy.task.id });
    const stale = await service.addKnowledge({ workspaceId: stuck.workspaceId, authorMemberId: stuck.worker.id, kind: 'learning', text: 'last durable step', taskId: stuck.task.id });
    await backdateKnowledge(service, stale.id, iso(-3_600_000));

    const healthySteward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(healthy.workspaceId, healthy.stewardMember.id));
    const stuckSteward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(stuck.workspaceId, stuck.stewardMember.id));
    const healthyOutcome = await healthySteward.onSupervisionBreach(breachFor(healthy.workspaceId, healthy.task.id, healthy.task.fence));
    const stuckOutcome = await stuckSteward.onSupervisionBreach(breachFor(stuck.workspaceId, stuck.task.id, stuck.task.fence));

    const live = service.state().sessions.filter((item) => [healthy.session.id, stuck.session.id].includes(item.id));
    expect(live).toHaveLength(2);
    expect(live.map((item) => `${item.state}/${item.lastTurnState}`)).toEqual(['running/running', 'running/running']);

    expect(healthyOutcome.classification).toBe('HEALTHY');
    expect(healthyOutcome.recommendation).toBe('CONTINUE');
    expect(healthyOutcome.evidenceRefs).toContain(fresh.id);
    expect(stuckOutcome.classification).toBe('STUCK');
    expect(stuckOutcome.recommendation).toBe('STEER');
    service.close();
  });

  it('escalates a repeated STUCK subject to REASSIGN on the next generation', async () => {
    // Catches: mapping every STUCK to STEER, so a subject that stayed stuck
    // across generations never escalates.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-reassign-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task } = await seed(service);
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id, { cooldownMs: 0 }));
    const first = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, 0));
    const second = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, 1));
    expect(first.recommendation).toBe('STEER');
    expect(second.classification).toBe('STUCK');
    expect(second.recommendation).toBe('REASSIGN');
    service.close();
  });

  it('reports TRANSPORT_INDETERMINATE with OWNER_DECISION rather than guessing progress', async () => {
    // Catches: classifying an unobservable runtime as STUCK, which would let the
    // Steward recommend a steer on evidence it does not have.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-indeterminate-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task, session } = await seed(service);
    // The runtime handle stops answering: the observation itself is lost, which
    // is a different fact from "observed and not progressing".
    await service.store.mutate((state: State) => { state.sessions.find((item) => item.id === session.id)!.externalId = 'paseo-lost-handle'; });
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    expect(outcome.classification).toBe('TRANSPORT_INDETERMINATE');
    expect(outcome.recommendation).toBe('OWNER_DECISION');
    service.close();
  });

  it('reads the durable blocked-on-decision record and routes a parked runtime to OWNER_DECISION, not STUCK', async () => {
    // Catches: classifying a runtime that is waiting on an unanswered decision
    // as STUCK and recommending a steer, and catches reading blockedness from
    // session.state, which observe() overwrites from provider status.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-blocked-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task, session } = await seed(service);
    const asked = await service.raiseDecision({ runtimeSessionId: session.id, question: 'which base branch should I use?', options: ['main', 'feat'] });
    const live = service.state().sessions.find((item) => item.id === session.id)!;
    expect(live.state).toBe('running');
    expect(live.blockedOnEventId).toBeDefined();

    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    expect(outcome.classification).toBe('DEGRADED');
    expect(outcome.recommendation).toBe('OWNER_DECISION');
    expect(outcome.evidenceRefs).toContain(asked.event.id);
    service.close();
  });

  it('recommends PARK for a subject task that has already reached a terminal lifecycle', async () => {
    // Catches: supervising a finished task, which would recommend STEER on work
    // that no longer exists.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-park-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task } = await seed(service);
    await service.store.mutate((state: State) => { state.tasks.find((item) => item.id === task.id)!.lifecycle = 'completed'; });
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));
    expect(outcome.classification).toBe('HEALTHY');
    expect(outcome.recommendation).toBe('PARK');
    service.close();
  });

  it('cites only evidence ids a reader can resolve in durable state', async () => {
    // Catches: fabricating an evidence pointer, or citing a live-only handle
    // that no reader can follow back to a durable row.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-evidence-'));
    const service = await control(root);
    const { workspaceId, stewardMember, task, session, worker } = await seed(service);
    const progress = await service.addKnowledge({ workspaceId, authorMemberId: worker.id, kind: 'learning', text: 'durable step', taskId: task.id });
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst({ narrative: 'n', provider: 'codex', model: 'gpt-5.6-terra' }), policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence));

    const state = service.state();
    const known = new Set<string>([
      ...state.tasks.map((item) => item.id), ...state.sessions.map((item) => item.id), ...state.results.map((item) => item.id),
      ...state.knowledge.map((item) => item.id), ...state.channelEvents.map((item) => item.id),
    ]);
    expect(outcome.evidenceRefs).toBeDefined();
    expect(outcome.evidenceRefs!.length).toBeGreaterThan(0);
    for (const ref of outcome.evidenceRefs!) expect(known.has(ref)).toBe(true);
    expect(outcome.evidenceRefs).toEqual(expect.arrayContaining([task.id, session.id, progress.id]));
    const event = state.channelEvents.find((item) => item.id === outcome.eventId)!;
    for (const ref of event.content.evidenceRefs) expect(known.has(ref)).toBe(true);
    expect(event.content.evidenceRefs).toContain(outcome.knowledgeId);
    service.close();
  });
});

describe('Workspace Steward — read-only, ephemeral, and owner-selected provider only', () => {
  it('leaves the subject task and its results untouched and authors the report as the Steward, not the requester', async () => {
    // Catches: giving the Steward the full ArcpService so it could claim the
    // subject task or submit a product Result, and catches attributing the
    // report to the Owner/Manager credential that triggered it.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-readonly-'));
    const service = await control(root);
    const { workspaceId, owner, stewardMember, task } = await seed(service);
    const before = service.state().tasks.find((item) => item.id === task.id)!;
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.requestAnalysis({ workspaceId, subjectTaskId: task.id, requestedByMemberId: owner.id });

    const after = service.state().tasks.find((item) => item.id === task.id)!;
    expect({ lifecycle: after.lifecycle, fence: after.fence, ownerMemberId: after.ownerMemberId }).toEqual({ lifecycle: before.lifecycle, fence: before.fence, ownerMemberId: before.ownerMemberId });
    expect(service.state().results.filter((item) => item.taskId === task.id)).toHaveLength(0);
    const report = service.state().knowledge.find((item) => item.id === outcome.knowledgeId)!;
    expect(report.authorMemberId).toBe(stewardMember.id);
    expect(report.authorMemberId).not.toBe(owner.id);
    expect(report.text).toContain('Manager/Deputy retains authority');
    service.close();
  });

  it('binds a cited report and analysis Result to the launched Steward runtime member', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-runtime-provenance-'));
    const service = await control(root);
    const { workspaceId, owner, stewardMember, worker, task, session } = await seed(service);
    const analysisMember = await service.joinWorkspace({ workspaceId, label: 'steward analyst', role: 'steward-analyst', capabilities: ['claim_task', 'submit_result', 'read_context', 'write_knowledge'] });
    const analysisTask = await service.createTask({ workspaceId, title: 'bounded Steward analysis', scope: 'steward_analysis' });
    await service.claimTask(analysisTask.id, analysisMember.member.id, 0);
    const result = await service.submitResult({ workspaceId, taskId: analysisTask.id, memberId: analysisMember.member.id, status: 'candidate', summary: 'cited runtime analysis', evidenceRefs: [task.id], expectedFence: 1 });
    const analysisSession: RuntimeSession = { ...session, id: 'runtime_steward_analysis', taskId: analysisTask.id, memberId: analysisMember.member.id, externalId: 'paseo-steward-analysis' };
    await service.store.mutate((state: State) => { state.sessions.push(analysisSession); });
    const analyst = new RecordingAnalyst({ narrative: 'cited runtime analysis', cited: true, evidenceRefs: [task.id], provider: 'codex', model: 'gpt-5.6-terra', runtimeSessionId: analysisSession.id, analysisTaskId: analysisTask.id });
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, policyFor(workspaceId, stewardMember.id));
    const outcome = await steward.requestAnalysis({ workspaceId, subjectTaskId: task.id, requestedByMemberId: owner.id });
    const report = service.state().knowledge.find((item) => item.id === outcome.knowledgeId)!;
    expect(outcome.status).toBe('analyzed');
    expect(report.authorMemberId).toBe(analysisSession.memberId);
    expect(result.memberId).toBe(analysisSession.memberId);
    expect(report.authorMemberId).not.toBe(owner.id);
    expect(report.authorMemberId).not.toBe(stewardMember.id);
    expect(report.text).toContain('analysis: cited runtime analysis');
    service.close();
  });

  it('refuses a manual analysis from a member without Steward authority', async () => {
    // Catches: dropping the authorization check, which would let any managed
    // Worker spend the Workspace's Steward budget.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-authz-'));
    const service = await control(root);
    const { workspaceId, stewardMember, worker, task } = await seed(service);
    const steward = new WorkspaceSteward(stewardViewOf(service), new RecordingAnalyst(), policyFor(workspaceId, stewardMember.id));
    await expect(steward.requestAnalysis({ workspaceId, subjectTaskId: task.id, requestedByMemberId: worker.id })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.state().knowledge.filter((entry) => entry.tags.includes(STEWARD_REPORT_TAG))).toHaveLength(0);
    service.close();
  });

  it('fails loudly on both triggers when the owner-selected provider is unavailable, and writes no report', async () => {
    // Catches: silently substituting another profile, and catches swallowing the
    // provider failure into a report the Owner would read as a real analysis.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-provider-down-'));
    const service = await control(root);
    const { workspaceId, owner, stewardMember, task } = await seed(service);
    const analyst = new RefusingAnalyst();
    const steward = new WorkspaceSteward(stewardViewOf(service), analyst, policyFor(workspaceId, stewardMember.id));
    await expect(steward.onSupervisionBreach(breachFor(workspaceId, task.id, task.fence))).rejects.toMatchObject({ code: 'steward_provider_unavailable' });
    await expect(steward.requestAnalysis({ workspaceId, subjectTaskId: task.id, requestedByMemberId: owner.id })).rejects.toMatchObject({ code: 'steward_provider_unavailable' });
    expect(analyst.calls).toBe(2);
    expect(service.state().knowledge.filter((entry) => entry.tags.includes(STEWARD_REPORT_TAG))).toHaveLength(0);
    expect(service.state().channelEvents.some((event) => event.content.summary.includes('Workspace Steward'))).toBe(false);
    service.close();
  });

  it('holds the Codex analyst when provider discovery reports nothing live, without launching a runtime', async () => {
    // Catches: launching on whatever provider happens to be live, or treating a
    // preflight hold as a soft warning.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-codex-hold-'));
    const cli = new FakeCli([]);
    const service = await control(root, cli);
    const { workspaceId, actor, task, session } = await seed(service);
    const analyst = new CodexRuntimeAnalyst(service, { profileId: 'codex-worker', actorId: actor.id, waitMs: 0, pollMs: 1 });
    const dossier = { key: analysisKeyOf(workspaceId, task.id, 0), workspace: service.state().workspaces.find((item) => item.id === workspaceId)!, subject: task, session, evidenceRefs: [task.id], materialProgress: { refs: [] }, classification: 'STUCK', recommendation: 'STEER', why: 'no progress', request: breachFor(workspaceId, task.id, 0) } as unknown as StewardDossier;
    await expect(analyst.analyze(dossier)).rejects.toMatchObject({ code: 'steward_provider_unavailable' });
    expect(cli.launches).toBe(0);
    expect(service.state().sessions.filter((item) => item.profileId === 'codex-worker' && item.id !== session.id)).toHaveLength(0);
    service.close();
  });

  it('runs the Codex analyst on the owner-selected profile and always terminates the runtime it started', async () => {
    // Catches: leaving an always-on Steward runtime behind, and catches
    // launching a profile other than the owner-selected one.
    const root = await mkdtemp(path.join(os.tmpdir(), 'steward-codex-ephemeral-'));
    const cli = new FakeCli();
    const service = await control(root, cli);
    const { workspaceId, actor, task, session } = await seed(service);
    const analyst = new CodexRuntimeAnalyst(service, { profileId: 'codex-worker', actorId: actor.id, waitMs: 0, pollMs: 1 });
    const dossier = { key: analysisKeyOf(workspaceId, task.id, 0), workspace: service.state().workspaces.find((item) => item.id === workspaceId)!, subject: task, session, evidenceRefs: [task.id], materialProgress: { refs: [] }, classification: 'STUCK', recommendation: 'STEER', why: 'no progress', request: breachFor(workspaceId, task.id, 0) } as unknown as StewardDossier;
    const narrative = await analyst.analyze(dossier);

    expect(narrative).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra', thinking: 'medium' });
    expect(cli.launches).toBe(1);
    expect(cli.lastLaunchArgs.join(' ')).toContain('--provider codex');
    expect(cli.lastLaunchArgs.join(' ')).toContain('--model gpt-5.6-terra');
    expect(cli.lastLaunchArgs.join(' ')).toContain('read-only Steward');
    const analysisSession = service.state().sessions.find((item) => item.id === narrative.runtimeSessionId)!;
    expect(analysisSession.state).toBe('terminal');
    expect(service.state().sessions.filter((item) => item.id !== session.id && item.state !== 'terminal')).toHaveLength(0);
    service.close();
  });
});

describe('Workspace Steward — member-facing API shares the automatic path', () => {
  let server: http.Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });

  it('deduplicates a member-requested HTTP analysis against the automatic one and never runs a second Codex analysis', async () => {
    // Catches: a second manual implementation behind the HTTP route. A parallel
    // path would not see the automatic run's durable report, so it would launch
    // a second Codex runtime and return `analyzed` instead of `deduplicated`.
    process.env.ARCP_STEWARD_WAIT_MS = '0';
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), 'steward-http-'));
      const cli = new FakeCli();
      const service = await control(root, cli);
      server = http.createServer(async (req, res) => { if (!(await handleArcp(req, res, service))) { res.statusCode = 404; res.end('{}'); } });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      const seeded = await seed(service);
      const launchesBeforeAutomatic = cli.launches;

      const steward = await stewardFor(service, seeded.workspaceId);
      const automatic = await steward.onSupervisionBreach(breachFor(seeded.workspaceId, seeded.task.id, seeded.task.fence));
      expect(automatic.status).toBe('timeout');
      const launchesAfterAutomatic = cli.launches;
      expect(launchesAfterAutomatic).toBe(launchesBeforeAutomatic + 1);
      expect((await steward.reports(seeded.workspaceId))).toHaveLength(0);

      const manual = await fetch(`${base}/v1/workspaces/${seeded.workspaceId}/steward/analyses`, {
        method: 'POST',
        headers: { 'x-arcp-member-key': seeded.ownerCredential, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: seeded.task.id }),
      });
      expect(manual.status).toBe(200);
      const manualBody: any = await manual.json();
      expect(manualBody.trigger).toBe('manual');
      expect(manualBody.status).toBe('timeout');
      expect(cli.launches).toBe(launchesAfterAutomatic + 1);
      expect(manualBody.knowledgeId).toBeUndefined();

      const reports = await fetch(`${base}/v1/workspaces/${seeded.workspaceId}/steward/reports`, { headers: { 'x-arcp-member-key': seeded.ownerCredential } });
      const reportBody: any = await reports.json();
      expect(reports.status).toBe(200);
      expect(reportBody).toHaveLength(0);

      const unauthenticated = await fetch(`${base}/v1/workspaces/${seeded.workspaceId}/steward/analyses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: seeded.task.id }),
      });
      expect(unauthenticated.status).toBe(401);
      service.close();
    } finally { delete process.env.ARCP_STEWARD_WAIT_MS; }
  });
});
