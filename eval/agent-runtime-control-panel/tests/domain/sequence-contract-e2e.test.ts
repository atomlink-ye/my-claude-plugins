import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { documentAddress } from '../../../../skills/agent-runtime-control-panel/runtime/src/content.js';
import { formatArtifactRef, parseArtifactRef } from '../../../../skills/agent-runtime-control-panel/runtime/src/document.js';
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
  const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'sequence contract e2e' });
  return { service, cli, actor, workspace: created.workspace, member: created.member };
}

function sequenceFacts(service: ArcpService, workspaceId: string, overrides: Record<string, unknown> = {}) {
  const state = service.state();
  return { workspaceId, channelEvents: state.channelEvents, deliveries: state.deliveries, tasks: state.tasks, results: state.results, sessions: state.sessions, members: state.members, goals: state.goals, knowledge: state.knowledge, documentRevisions: state.documentRevisions, reportingRoutes: [], executionSurfaces: [], surfaceClaims: [], nowMs: Date.now() + 3_600_000, ...overrides };
}

describe('Sequence Contract projection, episode A end to end from real durable ARCP data', () => {
  it('verifies a document-bound atomic launch, carries its ref, and raises no episode A anomaly', async () => {
    const { service, actor, workspace, member } = await fixture();
    const contract = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'atomic contract', body: 'Own exactly src/x.ts.\n' });
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'verified launch', contractDocumentRef: contract.ref, profileId: 'codex-worker', workspace: '/tmp' } as any);

    const projection = projectSequence(sequenceFacts(service, workspace.id));
    const contractBound = projection.entries.find((entry) => entry.id === `runtime:${started.session.id}:contract-bound`);
    expect(contractBound?.facts).toMatchObject({ boundAtLaunch: true, contractEvidence: 'verified', contractRef: contract.ref });
    expect(projectSequenceAnomalies(projection).anomalies.map((item) => item.kind)).not.toEqual(expect.arrayContaining(['contract_after_start', 'candidate_before_contract']));
    service.close();
  });

  it('labels a raw contract launch as asserted without changing its bound-at-launch fold', async () => {
    const { service, actor, workspace } = await fixture();
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'asserted launch', contract: 'Own exactly src/x.ts.', profileId: 'codex-worker', workspace: '/tmp' } as any);

    const projection = projectSequence(sequenceFacts(service, workspace.id));
    expect(projection.entries.find((entry) => entry.id === `runtime:${started.session.id}:contract-bound`)?.facts)
      .toMatchObject({ boundAtLaunch: true, contractEvidence: 'asserted' });
    service.close();
  });

  it('refutes a mismatched contract ref, including direct service refusal of that ref', async () => {
    const { service, actor, workspace, member } = await fixture();
    const contract = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'contract', body: 'Real authority.\n' });
    const mismatchedRef = formatArtifactRef({ ...parseArtifactRef(contract.ref)!, contentHash: documentAddress('Forged authority.\n') });
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'refused forged launch', contractDocumentRef: mismatchedRef, profileId: 'codex-worker', workspace: '/tmp' } as any))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'contractDocumentRef' });
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'stored forged ref', contract: 'Real authority.', profileId: 'codex-worker', workspace: '/tmp' } as any);
    const state = service.state();
    const sessions = state.sessions.map((session) => session.id === started.session.id ? { ...session, contractRef: mismatchedRef } : session);

    const projection = projectSequence(sequenceFacts(service, workspace.id, { sessions }));
    expect(projection.entries.find((entry) => entry.id === `runtime:${started.session.id}:contract-bound`)?.facts)
      .toMatchObject({ boundAtLaunch: false, contractEvidence: 'refuted', contractRef: mismatchedRef });
    service.close();
  });

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

    const projection = projectSequence(sequenceFacts(service, workspace.id));
    expect(projection.entries.flatMap(missingSequenceFacts)).toEqual([]);
    const contractBound = projection.entries.find((entry) => entry.kind === 'goal_contract_bound');
    expect(contractBound?.facts).toMatchObject({ boundAtLaunch: false });

    const anomalies = projectSequenceAnomalies(projection);
    expect(anomalies.anomalies.map((item) => item.kind)).toEqual(expect.arrayContaining(['contract_after_start', 'candidate_before_contract']));
    service.close();
  });
});
