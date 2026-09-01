import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService, CLAUDE_CACHE_DEFAULTS } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';

class FakeCli {
  private lastMode = 'auto';
  sends = 0;
  constructor(private readonly fail = false, private readonly providers = ['codex'], private readonly inspectValue: Record<string, unknown> = {}, private readonly modeListing?: unknown) {}
  async run(args: string[]) {
    if (this.fail && args[0] === 'run') throw new Error('timed out');
    if (args[0] === 'provider' && args[1] === 'ls') return { value: this.providers.map((provider) => ({ provider, status: 'available', enabled: true, modes: this.modeListing ?? (provider === 'pi' ? [] : ['auto', 'plan', provider === 'claude' ? 'bypassPermissions' : 'full-access']) })), stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: args[2] === 'codex' ? [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }] : args[2] === 'claude' ? [{ id: 'claude-opus-5', thinkingOptionIds: ['medium'] }] : [{ id: 'grok-cli/grok-4.6', thinkingOptionIds: [] }], stdout: '', stderr: '' };
    if (args[0] === 'run') { this.lastMode = args[args.indexOf('--mode') + 1] ?? ''; return { value: { id: 'paseo-session-1' }, stdout: '', stderr: '' }; }
    if (args[0] === 'ls') return { value: [{ id: 'paseo-session-1', status: 'idle' }], stdout: '', stderr: '' };
    if (args[0] === 'send') { this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') return { value: { id: 'paseo-session-1', status: 'idle', provider: this.providers[0], model: this.providers[0] === 'claude' ? 'claude-opus-5' : this.providers[0] === 'pi' ? 'grok-cli/grok-4.6' : 'gpt-5.6-terra', ...(this.providers[0] === 'pi' ? {} : { mode: this.lastMode }), thinking: 'medium', ...this.inspectValue }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}
async function control(root: string, fail = false, providers = ['codex'], inspectValue: Record<string, unknown> = {}, modeClientFactory?: any, modeListing?: unknown) {
  const companion = { store: { dir: root }, postMessage: async () => ({ id: 'message-1', delivery: { status: 'pending' } }), deleteMessage: async () => ({}) };
  const service = new ArcpService(companion as any, new FakeCli(fail, providers, inspectValue, modeListing) as any, undefined, modeClientFactory); await service.init(); return service;
}

describe('ARCP MVE control core', () => {
  it('keeps the shipped Claude cache thresholds at 55 and 60 minutes', () => {
    expect(CLAUDE_CACHE_DEFAULTS).toEqual({ expiringMinutes: 55, expiredMinutes: 60 });
  });
  it('teaches the mandatory claim and result fence commands', async () => {
    const text = await readFile(path.join(process.cwd(), '../../../skills/agent-runtime-control-panel/llms.txt'), 'utf8');
    expect(text).toContain('task claim TASK --expected-fence N');
    expect(text).toContain('result submit WORKSPACE --task TASK --summary … --expected-fence N');
  });
  it('keeps a native member, task fence, knowledge and result in one durable ControlWorkspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-workspace-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'hermes-owner', channel: 'hermes', conversationRef: 'opaque-conversation' });
    const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'shared canary' }); const workspace = created.workspace;
    expect(service.memberForCredential(created.credential).id).toBe(created.member.id);
    const joined = await service.joinWorkspace({ workspaceId: workspace.id, label: 'native-pi', role: 'reviewer', capabilities: ['knowledge', 'results'] });
    const task = await service.createTask({ workspaceId: workspace.id, title: 'review control plane' });
    await expect(service.claimTask(task.id, joined.member.id)).rejects.toMatchObject({ code: 'invalid_request' });
    await service.claimTask(task.id, joined.member.id, 0);
    await expect(service.claimTask(task.id, joined.member.id, 0)).rejects.toMatchObject({ code: 'stale_generation' });
    await expect(service.claimTask(task.id, 'missing-member')).rejects.toMatchObject({ code: 'unknown_recipient' });
    await service.addKnowledge({ workspaceId: workspace.id, authorMemberId: joined.member.id, kind: 'learning', text: 'native members share context' });
    await expect(service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: joined.member.id, status: 'candidate', summary: 'missing fence' })).rejects.toMatchObject({ code: 'invalid_request' });
    await service.submitResult({ workspaceId: workspace.id, taskId: task.id, memberId: joined.member.id, status: 'candidate', summary: 'review complete', expectedFence: 1 });
    const restarted = await control(root); const context = restarted.context(workspace.id);
    expect(context.roster).toHaveLength(2); expect(context.tasks[0].fence).toBe(1); expect(context.knowledge).toHaveLength(1); expect(context.results).toHaveLength(1);
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

  it('uses auto when Claude/Codex mode is omitted and never silently elevates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-launch-')); const service = await control(root);
    const codex = await service.preflight({ profileId: 'codex-worker' });
    expect(codex).toMatchObject({ action: 'launch', requested: { provider: 'codex', mode: 'auto' }, effective: { mode: 'auto' } });
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'safe default' });
    const launched = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect(launched.mode).toBe('auto'); expect(launched.observed?.mode).toBe('auto');
    const weak = await service.preflight({ provider: 'codex', model: 'gpt-5.6-terra', mode: 'plan', thinking: 'medium' });
    expect(weak).toMatchObject({ action: 'hold', launchable: false, requested: { mode: 'plan' }, recommendedCommands: [expect.stringContaining('--profile codex-full-access')] });
  });

  it('uses public SDK mode ids over CLI human mode labels', async () => {
    const modeClient = () => ({ connect: async () => {}, close: async () => {}, providers: { listModes: async () => ({ provider: 'codex', modes: [{ id: 'auto' }, { id: 'auto-review' }, { id: 'full-access' }] }) } });
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sdk-modes-')); const service = await control(root, false, ['codex'], {}, modeClient, 'Default Permissions, Auto-review, Full Access');
    expect(await service.preflight({ profileId: 'codex-worker' })).toMatchObject({ action: 'launch', liveModes: ['auto', 'auto-review', 'full-access'] });
    const { actor } = await service.registerActor({ clientIdentity: 'sdk-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'SDK auto' });
    expect(await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' })).toMatchObject({ mode: 'auto', observed: { mode: 'auto' } });
  });

  it('allows only an explicit elevated profile and leaves Pi/Grok mode-less', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-elevated-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'approved disposable' });
    const elevated = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-full-access' });
    expect(elevated.mode).toBe('full-access'); expect(elevated.observed?.mode).toBe('full-access');
    const pi = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-')), false, ['pi']);
    expect(await pi.preflight({ profileId: 'pi-grok-worker' })).toMatchObject({ action: 'launch', requested: { provider: 'pi', model: 'grok-cli/grok-4.6' } });
    await expect(pi.preflight({ provider: 'pi', model: 'grok-cli/grok-4.6', mode: 'auto' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('projects quality-labelled telemetry and retains requested/observed mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-observation-')); const service = await control(root, false, ['codex'], { status: 'permission', mode: 'full-access', pendingPermissions: [{ id: 'permission-private' }], activeTurn: { id: 'turn-1' }, lastUsage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 8, contextWindowUsedTokens: 50, contextWindowMaxTokens: 100 }, timeline: [{ type: 'compaction', status: 'completed', timestamp: '2026-01-01T00:00:00.000Z' }] });
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'observe' });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    const status = await service.runtimeStatus(runtime.id);
    expect(status.observation).toMatchObject({ health: 'attention', mismatch: true, pendingPermissions: 1, context: { used: 50, max: 100, ratio: 0.5, quality: 'reported' }, compaction: { count: 1, status: 'completed' }, requested: { mode: 'auto' }, observed: { mode: 'full-access' } });
  });

  it('guards Claude interrupt and stale cache reuse without mutating before confirmation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-claude-guard-')); const activity = new Date(Date.now() - 56 * 60_000).toISOString();
    const service = await control(root, false, ['claude'], { lastUserMessageAt: activity, activeTurn: { id: 'turn-a' } });
    const { actor } = await service.registerActor({ clientIdentity: 'claude-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'guarded Claude' }); const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'claude-manager' });
    const normal = await service.deliver({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'safe point delivery' }) as any;
    expect(normal.action).toBe('hold'); expect(normal.recommendedCommands.join('\n')).toContain('arcp reuse'); expect((service.cli as any).sends).toBe(0);
    const interrupt = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test' }) as any;
    expect(interrupt).toMatchObject({ action: 'hold' }); expect(service.state().deliveries).toHaveLength(0);
    (service.cli as any).inspectValue.activeTurn = { id: 'turn-b' };
    const stale = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test', confirmation: interrupt.confirmation }) as any;
    expect(stale).toMatchObject({ action: 'hold', why: expect.stringContaining('stale') }); expect((service.cli as any).sends).toBe(0);
    const retry = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test' }) as any;
    const sent = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test', confirmation: retry.confirmation }) as any;
    expect(sent.state).toBe('delivered'); expect((service.cli as any).sends).toBe(1);
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
