import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

describe('ARCP RuntimeSession generation lifecycle', () => {
  it('replaces a native runtime in place and invalidates the old delivery episode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-generation-'));
    const cli = new FakePaseoCli({ inspectValue: { id: 'runtime-generation-2' } });
    const { service } = await createControl(root, { cli });
    const { actor } = await service.registerActor({ clientIdentity: 'generation-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'generation lifecycle' });
    const member = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'replace runtime', workspaceId: workspace.workspace.id });
    const first = await service.launch({ actorId: actor.id, goalId: goal.id, workspaceId: workspace.workspace.id, memberId: member.member.id, profileId: 'codex-worker' });
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: member.member.id, kind: 'finding', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: 'old episode', evidenceRefs: [], notify: false });
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'old-generation-delivery', fromActorId: actor.id, runtimeSessionId: first.id, generation: first.generation, body: 'old episode', command: 'normal', eventId: event.id, state: 'waiting_safe_point', createdAt: new Date().toISOString() }));

    const replaced = await service.replaceRuntime({ runtimeSessionId: first.id, profileId: 'codex-worker' });
    const state = service.state();
    expect(replaced.id).toBe(first.id);
    expect(replaced.generation).toBe(first.generation + 1);
    expect(replaced.externalId).toBe(first.externalId);
    expect(state.sessions).toHaveLength(1);
    expect(state.deliveries.find((item) => item.id === 'old-generation-delivery')).toMatchObject({ state: 'withdrawn', generation: first.generation, reason: 'target runtime generation was replaced' });
    expect(state.channelEvents.find((item) => item.id === event.id)).toMatchObject({ consumptionState: 'invalidated' });
    service.close();
  });

  it('rejects a result carrying an old runtime generation while accepting the current one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-result-generation-'));
    const { service } = await createControl(root, { cli: new FakePaseoCli({ inspectValue: { id: 'runtime-generation-1' } }) });
    const { actor } = await service.registerActor({ clientIdentity: 'result-generation-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'result generation' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'generation result', profileId: 'codex-worker' }) as any;
    const claimed = await service.claimTask(started.task.id, started.member.id, 0);
    const replaced = await service.replaceRuntime({ runtimeSessionId: started.session.id, profileId: 'codex-worker' });

    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: claimed.id, memberId: started.member.id, status: 'candidate', summary: 'stale result', expectedFence: 1, runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation })).rejects.toMatchObject({ code: 'stale_generation' });
    const current = await service.submitResult({ workspaceId: workspace.workspace.id, taskId: claimed.id, memberId: started.member.id, status: 'candidate', summary: 'current result', expectedFence: 1, runtimeSessionId: replaced.id, runtimeGeneration: replaced.generation });
    expect(current).toMatchObject({ runtimeSessionId: replaced.id, runtimeGeneration: replaced.generation, summary: 'current result' });
    service.close();
  });
});
