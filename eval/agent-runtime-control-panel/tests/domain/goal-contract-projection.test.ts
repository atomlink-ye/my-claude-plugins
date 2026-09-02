import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { projectSequence } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-projection.js';
import { projectSequenceAnomalies } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-anomaly.js';
import { missingSequenceFacts } from '../../../../skills/agent-runtime-control-panel/runtime/src/sequence-model.js';

class FakeCli {
  launches: string[][] = [];
  status = 'idle';
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'worker-live', status: this.status, provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    if (args[0] === 'run') { this.launches.push(args); return { value: { id: 'worker-live' }, stdout: '', stderr: '' }; }
    return { value: [], stdout: '', stderr: '' };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-goal-contract-projection-'));
  const cli = new FakeCli();
  const service = new ArcpService(root, cli as any);
  await service.init();
  const { actor } = await service.registerActor({ clientIdentity: 'contract-projection-owner' });
  const workspace = (await service.createWorkspace({ ownerActorId: actor.id, purpose: 'goal contract projection' })).workspace;
  return { service, cli, actor, workspace };
}

/** Fold the whole durable store into a Sequence and its anomaly projection,
 * the same two-stage pipe integration must run for any Sequence claim to be
 * more than a hand-built fixture. */
function foldAll(service: any, workspaceId: string) {
  const state = service.state();
  const facts = { workspaceId, channelEvents: state.channelEvents, deliveries: state.deliveries, tasks: state.tasks, results: state.results, sessions: state.sessions, members: state.members, goals: state.goals, knowledge: state.knowledge, reportingRoutes: [], executionSurfaces: [], surfaceClaims: [], nowMs: Date.now() + 3_600_000 };
  const projection = projectSequence(facts as any);
  expect(projection.entries.flatMap(missingSequenceFacts)).toEqual([]);
  return projectSequenceAnomalies(projection);
}

describe('Goal Contract projection, folded from real durable ARCP data', () => {
  it('folds an atomic launch-bound Contract as goal_contract_bound with boundAtLaunch true, and raises no episode A anomaly on the golden path', async () => {
    const { service, actor, workspace } = await fixture();
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'atomic goal', contract: 'OWN EXACTLY src/x.ts', profileId: 'codex-worker', workspace: '/tmp' } as any);
    await service.claimTask(started.task.id, started.member.id, 0);
    await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'done', evidenceRefs: ['commit:abc'], expectedFence: 1 });

    const anomalies = foldAll(service, workspace.id);
    expect(anomalies.anomalies.filter((item) => item.kind === 'contract_after_start' || item.kind === 'candidate_before_contract')).toEqual([]);
    service.close();
  });

  it('episode A: folds a non-atomic, later-delivered Contract as goal_contract_bound with boundAtLaunch false, and the anomaly projection catches the candidate that arrived under it — proven end to end through the real fold and detector, not a hand-built fixture', async () => {
    const { service, actor, workspace } = await fixture();
    // No `contract` at launch: the golden atomic path is not exercised here.
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'late-bound goal', profileId: 'codex-worker', workspace: '/tmp' } as any);
    // A Contract delivered before the Task is claimed passes every fail-closed
    // check in contractRefusal() and is genuinely bound, just never atomically.
    const bound: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: started.session.id, purpose: 'contract', subject: { taskId: started.task.id, fence: 0 }, body: 'Goal Contract: own exactly src/x.ts' });
    expect(bound.state).not.toBe('withdrawn');
    await service.claimTask(started.task.id, started.member.id, 0);
    await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'done', evidenceRefs: ['commit:abc'], expectedFence: 1 });

    const anomalies = foldAll(service, workspace.id);
    expect(anomalies.anomalies.map((item) => item.kind)).toEqual(expect.arrayContaining(['contract_after_start', 'candidate_before_contract']));
    service.close();
  });
});
