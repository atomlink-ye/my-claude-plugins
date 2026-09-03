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
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sequence-contract-e2e-'));
  const cli = new FakeCli();
  const service = new ArcpService(root, cli as any);
  await service.init();
  const { actor } = await service.registerActor({ clientIdentity: 'contract-e2e-owner' });
  const workspace = (await service.createWorkspace({ ownerActorId: actor.id, purpose: 'sequence contract e2e' })).workspace;
  return { service, cli, actor, workspace };
}

describe('Sequence Contract projection, episode A end to end from real durable ARCP data', () => {
  it('folds a real, later-delivered (never atomic) Goal Contract into goal_contract_bound, and the real detector fires both episode A anomaly kinds from that fold — no hand-built fixture', async () => {
    const { service, actor, workspace } = await fixture();
    // No `contract` at launch: nothing durable claims this launch was atomic.
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'late-bound goal', profileId: 'codex-worker', workspace: '/tmp' } as any);
    // A Contract Delivery that reaches the runtime before the Task is claimed
    // survives every fail-closed check in contractRefusal(); it is genuinely
    // bound, just never atomically, which is exactly episode A.
    const bound: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: started.session.id, purpose: 'contract', subject: { taskId: started.task.id, fence: 0 }, body: 'Goal Contract: own exactly src/x.ts' });
    expect(bound.state).not.toBe('withdrawn');
    await service.claimTask(started.task.id, started.member.id, 0);
    await service.submitResult({ workspaceId: workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'done', evidenceRefs: ['commit:abc'], expectedFence: 1, runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation });

    const state = service.state();
    const facts = { workspaceId: workspace.id, channelEvents: state.channelEvents, deliveries: state.deliveries, tasks: state.tasks, results: state.results, sessions: state.sessions, members: state.members, goals: state.goals, knowledge: state.knowledge, reportingRoutes: [], executionSurfaces: [], surfaceClaims: [], nowMs: Date.now() + 3_600_000 };
    const projection = projectSequence(facts as any);
    expect(projection.entries.flatMap(missingSequenceFacts)).toEqual([]);
    const contractBound = projection.entries.find((entry) => entry.kind === 'goal_contract_bound');
    expect(contractBound?.facts).toMatchObject({ boundAtLaunch: false });

    const anomalies = projectSequenceAnomalies(projection);
    expect(anomalies.anomalies.map((item) => item.kind)).toEqual(expect.arrayContaining(['contract_after_start', 'candidate_before_contract']));
    service.close();
  });
});
