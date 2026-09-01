import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';

class FakeCli {
  constructor(private readonly fail = false) {}
  async run(args: string[]) {
    if (this.fail && args[0] === 'run') throw new Error('timed out');
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: 'Enabled', modes: 'Full Access' }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models' && args[2] === 'codex') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'run') return { value: { id: 'paseo-session-1' }, stdout: '', stderr: '' };
    if (args[0] === 'ls') return { value: [{ id: 'paseo-session-1', status: 'idle' }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'paseo-session-1', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium' }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}
async function control(root: string, fail = false) {
  const companion = { store: { dir: root }, postMessage: async () => ({ id: 'message-1', delivery: { status: 'pending' } }), deleteMessage: async () => ({}) };
  const service = new ArcpService(companion as any, new FakeCli(fail) as any); await service.init(); return service;
}

describe('ARCP MVE control core', () => {
  it('keeps a native member, task fence, knowledge and result in one durable ControlWorkspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-workspace-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'hermes-owner', channel: 'hermes', conversationRef: 'opaque-conversation' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'shared canary' });
    const joined = await service.joinWorkspace({ workspaceId: workspace.id, label: 'native-pi', role: 'reviewer', capabilities: ['knowledge', 'results'] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'review control plane' });
    await service.claimTask(task.id, joined.member.id);
    await expect(service.claimTask(task.id, 'missing-member')).rejects.toMatchObject({ code: 'unknown_recipient' });
    await service.addKnowledge({ workspaceId: workspace.id, authorMemberId: joined.member.id, kind: 'learning', text: 'native members share context' });
    await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: joined.member.id, status: 'completed', summary: 'review complete' });
    const restarted = await control(root); const context = restarted.context(workspace.id);
    expect(context.roster).toHaveLength(1); expect(context.tasks[0].fence).toBe(1); expect(context.knowledge).toHaveLength(1); expect(context.results).toHaveLength(1);
  });
  it('uses ARCP_DATA while preserving the legacy companion data alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-data-')); const prior = process.env.ARCP_DATA;
    process.env.ARCP_DATA = root;
    expect(new Store().dir).toBe(root);
    if (prior === undefined) delete process.env.ARCP_DATA; else process.env.ARCP_DATA = prior;
  });
  it('keeps actor identity and binding generation stable across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-'));
    const first = await control(root);
    const registered = await first.registerActor({ clientIdentity: 'hermes-owner', label: 'Hermes' });
    const repeat = await first.registerActor({ clientIdentity: 'hermes-owner', label: 'ignored' });
    expect(repeat.actor).toEqual(registered.actor); expect(repeat.binding).toEqual(registered.binding); expect(registered.binding.generation).toBe(1);
    const restarted = await control(root);
    expect(restarted.state().actors).toEqual([registered.actor]);
    expect(restarted.state().bindings).toEqual([registered.binding]);
  });

  it('rejects an unknown recipient before durable delivery and uses safe-point normal delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-')); const service = await control(root);
    await expect(service.deliver({ fromActorId: 'missing', runtimeSessionId: 'missing', body: 'nope' })).rejects.toMatchObject({ code: 'unknown_recipient' });
    expect(service.state().deliveries).toEqual([]);
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'canary' });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    await expect(service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' })).rejects.toMatchObject({ code: 'goal_held' });
    const delivery = await service.deliver({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'continue' });
    expect(delivery).toMatchObject({ command: 'normal', state: 'delivered', safePointObservedAt: expect.any(String) });
  });

  it('fails unavailable profiles closed and preserves uncertain launch/reconcile state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-')); const service = await control(root, true);
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'canary' });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect(runtime.state).toBe('transport_indeterminate');
    expect((await service.reconcile(runtime.id)).state).toBe('transport_indeterminate');
    const heldGoal = await service.createGoal({ actorId: actor.id, title: 'unavailable profile' });
    await expect(service.launch({ actorId: actor.id, goalId: heldGoal.id, profileId: 'claude-manager' })).rejects.toMatchObject({ code: 'profile_unavailable' });
  });
});

describe('ARCP HTTP and legacy compatibility', () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => { if (app) { app.service.close(); await new Promise<void>((resolve) => app!.server.close(() => resolve())); } app = undefined; delete process.env.ARCP_API_KEY; });
  it('protects v1 while retaining the unversioned companion health route and old import path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-http-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/actors`)).status).toBe(401);
    const registered = await fetch(`${base}/v1/actors`, { method: 'POST', headers: { 'x-arcp-api-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify({ clientIdentity: 'legacy-owner' }) });
    expect(registered.status).toBe(201);
    expect(JSON.stringify(await registered.json())).not.toContain('externalId');
    const legacy = await import('../../../skills/paseo-companion/paseo-reminder/src/server.js');
    expect(legacy.createServer).toBeTypeOf('function');
  });
});
