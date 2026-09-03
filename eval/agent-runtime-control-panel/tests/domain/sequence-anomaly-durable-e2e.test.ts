import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { projectSequence } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-projection.js';
import { projectSequenceAnomalies } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-anomaly.js';
import { missingSequenceFacts } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-model.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sequence-anomaly-e2e-'));
  const service = new ArcpService(root, new FakePaseoCli() as any);
  await service.init();
  const { actor } = await service.registerActor({ clientIdentity: `sequence-anomaly-${root}` });
  const { workspace } = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'durable sequence anomaly proof' });
  return { service, actor, workspace };
}

function anomalyKinds(service: ArcpService, workspaceId: string) {
  const state = service.state();
  const projection = projectSequence({
    workspaceId,
    channelEvents: state.channelEvents,
    deliveries: state.deliveries,
    tasks: state.tasks,
    results: state.results,
    sessions: state.sessions,
    members: state.members,
    goals: state.goals,
    knowledge: state.knowledge,
    reportingRoutes: [],
    executionSurfaces: state.executionSurfaces,
    surfaceClaims: state.surfaceClaims,
    nowMs: Date.now() + 3_600_000,
  });
  expect(projection.entries.flatMap(missingSequenceFacts)).toEqual([]);
  return { projection, anomalies: projectSequenceAnomalies(projection) };
}

function expectExactKinds(service: ArcpService, workspaceId: string, expected: string[]) {
  const actual = anomalyKinds(service, workspaceId).anomalies.anomalies.map((item) => item.kind).sort();
  expect(actual).toEqual([...expected].sort());
}

async function managed(service: ArcpService, actorId: string, workspaceId: string, title: string, extra: Record<string, unknown> = {}) {
  const started = await service.startManaged({ actorId, workspaceId, title, profileId: 'codex-worker', workspace: '/tmp', ...extra } as any);
  if (!('session' in started)) throw new Error(`managed launch did not start: ${JSON.stringify(started)}`);
  return started;
}

describe('Sequence anomaly projection from durable ArcpService data', () => {
  it('does not flag a launch-bound Goal Contract, while retaining its launch evidence', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const started: any = await managed(service, actor.id, workspace.id, 'atomic contract', { contract: 'Own the assigned checkout and report a candidate.' });
      const { projection, anomalies } = anomalyKinds(service, workspace.id);
      expect(started.session.contractBoundAtLaunch).toBe(true);
      expect(projection.entries.find((entry) => entry.kind === 'runtime_launched')?.facts).toMatchObject({ runtimeId: started.session.id, generation: 1, hasContract: true });
      expect(projection.entries.find((entry) => entry.kind === 'goal_contract_bound')?.facts).toEqual({ goalId: started.goal.id, boundAtLaunch: true });
      expect(anomalies.anomalies).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('detects contract_after_start and candidate_before_contract from a late durable Contract Delivery', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const started: any = await managed(service, actor.id, workspace.id, 'late contract');
      const delivery: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: started.session.id, purpose: 'contract', subject: { taskId: started.task.id, fence: 0 }, body: 'Goal Contract: own the assigned checkout.' });
      expect(delivery.state).toBe('delivered');
      await service.claimTask(started.task.id, started.member.id, 0);
      await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'candidate after late contract', evidenceRefs: ['commit:durable'], expectedFence: 1 });
      const { anomalies } = anomalyKinds(service, workspace.id);
      expect(anomalies.anomalies.map((item) => item.kind).sort()).toEqual(['candidate_before_contract', 'contract_after_start']);
    } finally {
      service.close();
    }
  });

  it('detects stale_safe_point across replacement RuntimeSession rows sharing one lineage', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const first: any = await managed(service, actor.id, workspace.id, 'stale safe point');
      await service.stopRuntime(first.session.id);
      const second: any = await service.launch({ actorId: actor.id, goalId: first.goal.id, workspaceId: workspace.id, profileId: 'codex-worker', workspace: '/tmp' });
      expect(second.generation).toBe(2);
      const current = await service.deliver({ fromActorId: actor.id, runtimeSessionId: second.id, body: 'current delivery' });
      expect(current.safePointObservedAt).toBeDefined();
      await service.store.mutate((state: any) => {
        // The public delivery API will not manufacture a safe point for an
        // already-stopped runtime. Persist this impossible stale receipt to
        // exercise the detector against the durable state an operator may find.
        const at = new Date().toISOString();
        state.deliveries.push({ id: 'stale-safe-point', fromActorId: actor.id, runtimeSessionId: first.session.id, generation: 1, body: 'old delivery', command: 'normal', state: 'waiting_safe_point', createdAt: at, safePointObservedAt: at });
      });
      expectExactKinds(service, workspace.id, ['stale_safe_point']);
    } finally {
      service.close();
    }
  });

  it('detects late_self_wake when an old-generation Delivery is delivered after replacement', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const first: any = await managed(service, actor.id, workspace.id, 'late wake');
      await service.stopRuntime(first.session.id);
      const second: any = await service.launch({ actorId: actor.id, goalId: first.goal.id, workspaceId: workspace.id, profileId: 'codex-worker', workspace: '/tmp' });
      expect(second.generation).toBe(2);
      // The public delivery path refuses obsolete generations. Persist the
      // impossible delivered receipt to prove detection of corrupted durable
      // history rather than inventing a liveness signal.
      await service.store.mutate((state: any) => state.deliveries.push({ id: 'late-wake', fromActorId: actor.id, runtimeSessionId: first.session.id, generation: 1, body: 'old delivery', command: 'normal', state: 'delivered', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() }));
      expectExactKinds(service, workspace.id, ['late_self_wake']);
    } finally {
      service.close();
    }
  });

  it('detects duplicate_goal from two durable Goals with the same title', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      await service.createGoal({ actorId: actor.id, workspaceId: workspace.id, title: 'same durable goal' });
      await service.createGoal({ actorId: actor.id, workspaceId: workspace.id, title: 'same durable goal' });
      expectExactKinds(service, workspace.id, ['duplicate_goal']);
    } finally {
      service.close();
    }
  });

  it('does not flag a legitimate same-member replacement after real stopRuntime, but detects an impossible durable overlap', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const first: any = await managed(service, actor.id, workspace.id, 'duplicate worker');
      await service.stopRuntime(first.session.id);
      const replacement: any = await service.launch({ actorId: actor.id, goalId: first.goal.id, workspaceId: workspace.id, profileId: 'codex-worker', workspace: '/tmp', memberId: first.member.id, taskId: first.task.id } as any);
      expect(replacement.generation).toBe(2);
      expectExactKinds(service, workspace.id, []);
      await service.store.mutate((state: any) => {
        // launch() rejects a second live session for this Goal. Persist the
        // impossible overlap so the detector remains able to report corrupted
        // durable state, after proving the normal replacement path above.
        const source = state.sessions.find((item: any) => item.id === replacement.id);
        state.sessions.push({ ...structuredClone(source), id: 'overlapping-worker', generation: 3, externalId: 'paseo-session-overlap', createdAt: new Date().toISOString(), state: 'idle', lastObservedAt: undefined });
      });
      expectExactKinds(service, workspace.id, ['duplicate_worker']);
    } finally {
      service.close();
    }
  });

  it('detects surface_conflict from two durable active writer claims', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const first: any = await managed(service, actor.id, workspace.id, 'surface conflict');
      // This is a deliberately corrupted durable topology: the public claim
      // API rejects a second writer, so persist the competing claim directly
      // to prove the detector catches what an operator would find on disk.
      const surfaceId = 'surface-conflict';
      const otherGoal = await service.createGoal({ actorId: actor.id, workspaceId: workspace.id, title: 'other surface goal' });
      const otherMember = await service.joinWorkspace({ workspaceId: workspace.id, label: 'other writer', role: 'worker' });
      await service.store.mutate((state: any) => {
        const at = new Date().toISOString();
        state.executionSurfaces.push({ id: surfaceId, repositoryId: 'repo-conflict', checkout: { id: 'checkout-conflict', repositoryId: 'repo-conflict', path: '/tmp/conflict' }, kind: 'working', operationalState: 'active', visibilityState: 'visible', adapterBindings: {}, createdAt: at, updatedAt: at });
        const source = state.sessions.find((item: any) => item.id === first.session.id);
        state.sessions.push({ ...structuredClone(source), id: 'conflicting-writer', goalId: otherGoal.id, memberId: otherMember.member.id, generation: 1, externalId: 'paseo-session-conflict', createdAt: new Date().toISOString(), state: 'idle' });
        state.surfaceClaims.push({ id: 'first-claim', executionSurfaceId: surfaceId, runtimeSessionId: first.session.id, holder: first.session.id, mode: 'writer', active: true, createdAt: at });
        state.surfaceClaims.push({ id: 'conflicting-claim', executionSurfaceId: surfaceId, runtimeSessionId: 'conflicting-writer', holder: 'conflicting-writer', mode: 'writer', active: true, createdAt: new Date().toISOString() });
      });
      expectExactKinds(service, workspace.id, ['surface_conflict']);
    } finally {
      service.close();
    }
  });

  it('detects wrong_member_attribution from a durable Task claim and mismatched Result', async () => {
    const { service, actor, workspace } = await fixture();
    try {
      const started: any = await managed(service, actor.id, workspace.id, 'wrong attribution');
      await service.claimTask(started.task.id, started.member.id, 0);
      const other = await service.joinWorkspace({ workspaceId: workspace.id, label: 'other member', role: 'owner' });
      // submitResult enforces claimant identity; persist a contradictory
      // Result only to prove the detector can expose a corrupted durable log.
      await service.store.mutate((state: any) => {
        state.results.push({ id: 'wrong-member-result', workspaceId: workspace.id, taskId: started.task.id, memberId: other.member.id, fence: 1, status: 'candidate', summary: 'mismatched durable submitter', evidenceRefs: ['commit:mismatch'], createdAt: new Date().toISOString() });
      });
      expectExactKinds(service, workspace.id, ['wrong_member_attribution']);
    } finally {
      service.close();
    }
  });
});
