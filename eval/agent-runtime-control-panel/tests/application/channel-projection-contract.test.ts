import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderChannelCard } from '../../../../skills/agent-runtime-control-panel/runtime/src/channel-projection.js';
import { renderTuiSnapshot } from '../../../../skills/agent-runtime-control-panel/runtime/src/tui.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

const control = async () => (await createControl(await mkdtemp(path.join(os.tmpdir(), 'arcp-projection-')), { cli: new FakePaseoCli() })).service;

describe('Channel projection application contract', () => {
  it('uses one canonical projection across channel list, inbox, panorama/TUI and the delivery envelope', async () => {
    const service = await control();
    const { actor } = await service.registerActor({ clientIdentity: 'projection-owner' });
    const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'projection parity' });
    const workspaceId = created.workspace.id;
    const manager = await service.joinWorkspace({ workspaceId, label: 'Hermes Owner Deputy', role: 'manager' });
    const worker = await service.joinWorkspace({ workspaceId, label: 'Codex Worker', role: 'worker' });
    const task = await service.createTask({ workspaceId, title: 'Round-3 Lane E: human-readable Channel projection' });
    await service.store.mutate((state: any) => state.sessions.push({ id: 'live-manager', actorId: actor.id, goalId: 'goal-manager', bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'live-manager', createdAt: new Date().toISOString() }));
    const event = await service.publishChannelEvent({ workspaceId, taskId: task.id, sourceMemberId: worker.member.id, targetMemberId: manager.member.id, kind: 'task_completed', urgency: 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Task ${task.id} completed by durable Result`, evidenceRefs: [] });
    const listed = service.channelEvents(workspaceId).find((item) => item.id === event.id)!;
    const card = renderChannelCard(listed.projection);
    expect(card).toContain('[Completed] Round-3 Lane E');
    expect(card).toContain('From: Codex Worker · worker');
    expect(card).toContain(`Refs: Task ${task.id}`);
    expect(card).not.toContain(`Task ${task.id} completed by durable Result`);
    expect(card.split('\n').slice(0, -1).join('\n')).not.toMatch(/\b(?:knowledge|task|result|event|member)_[0-9a-f]{6,}/);
    expect(listed.projection.headline).toBe('Task completed by durable Result');
    const delivered = service.context(workspaceId, manager.member.id).inbox.find((item: any) => item.eventId === event.id)!;
    expect(renderChannelCard((delivered as any).projection)).toBe(card);
    expect((delivered as any).markdown).toBe(listed.markdown);
    expect((delivered as any).body).toBe(listed.markdown);
    expect((delivered as any).body).not.toBe(event.content.summary);
    expect(listed.markdown).toContain('### ✅ Completed · Round-3 Lane E');
    const snapshot = renderTuiSnapshot(await service.panorama(workspaceId));
    for (const line of card.split('\n')) expect(snapshot).toContain(`  ${line}`);
    service.close();
  });
});
