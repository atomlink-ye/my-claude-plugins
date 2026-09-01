import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService, ArcpStore, CLAUDE_CACHE_DEFAULTS } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createServer } from '../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { CompanionService } from '../../../skills/agent-runtime-control-panel/runtime/src/service.js';
import { Store } from '../../../skills/agent-runtime-control-panel/runtime/src/store.js';
import { renderTuiSnapshot } from '../../../skills/agent-runtime-control-panel/runtime/src/tui.js';
import { HermesAcpAdapter } from '../../../skills/agent-runtime-control-panel/runtime/src/hermes-acp.js';

const execFileAsync = promisify(execFile);

class FakeCli {
  private lastMode = 'auto';
  sends = 0;
  lastLaunchArgs: string[] = [];
  lastEnv: Record<string, string> = {};
  constructor(private readonly fail = false, private readonly providers = ['codex'], private readonly inspectValue: Record<string, unknown> = {}, private readonly modeListing?: unknown) {}
  async run(args: string[], options: { env?: Record<string, string> } = {}) {
    if (options.env) this.lastEnv = options.env;
    if (this.fail && args[0] === 'run') throw new Error('timed out');
    if (args[0] === 'provider' && args[1] === 'ls') return { value: this.providers.map((provider) => ({ provider, status: 'available', enabled: true, modes: this.modeListing ?? (provider === 'pi' ? [] : ['auto', 'plan', provider === 'claude' ? 'bypassPermissions' : 'full-access']) })), stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: args[2] === 'codex' ? [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }] : args[2] === 'claude' ? [{ id: 'claude-opus-5', thinkingOptionIds: ['medium'] }] : [{ id: 'grok-cli/grok-4.6', thinkingOptionIds: [] }], stdout: '', stderr: '' };
    if (args[0] === 'run') { this.lastLaunchArgs = args; this.lastMode = args[args.indexOf('--mode') + 1] ?? ''; return { value: { id: 'paseo-session-1' }, stdout: '', stderr: '' }; }
    if (args[0] === 'ls') return { value: [{ id: 'paseo-session-1', status: 'idle' }], stdout: '', stderr: '' };
    if (args[0] === 'send' || args[0] === 'start-turn') { this.sends += 1; return { value: {}, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') return { value: { id: 'paseo-session-1', status: 'idle', provider: this.providers[0], model: this.providers[0] === 'claude' ? 'claude-opus-5' : this.providers[0] === 'pi' ? 'grok-cli/grok-4.6' : 'gpt-5.6-terra', ...(this.providers[0] === 'pi' ? {} : { mode: this.lastMode }), thinking: 'medium', ...this.inspectValue }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}

class FakeAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  promptCount = 0;
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        if (request.method === 'initialize') this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\n');
        if (request.method === 'session/new') this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'acp-session-1' } }) + '\n');
        if (request.method === 'session/prompt') this.promptCount += 1;
        if (request.method === 'session/cancel') this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
      }
    });
  }
  kill(): boolean { this.exitCode = 0; this.emit('close'); return true; }
  update(sessionUpdate: string, extra: Record<string, unknown> = {}): void { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-session-1', update: { sessionUpdate, ...extra } } }) + '\n'); }
  permission(): void { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/request_permission', params: { sessionId: 'acp-session-1' } }) + '\n'); }
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
    expect(context.events.map((event: any) => event.kind)).toEqual(expect.arrayContaining(['task_claimed', 'task_candidate', 'decision_required']));
  });
  it('returns a distinct managed Worker credential without replacing the owner credential', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-managed-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'manager' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'managed worker' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'managed task', profileId: 'codex-worker' });
    expect(started).toMatchObject({ member: { joinKind: 'managed' }, credential: expect.any(String) });
    expect((started as any).credential).not.toBe(workspace.credential);
    expect(service.memberForCredential((started as any).credential).id).toBe((started as any).member.id);
    expect(service.memberForCredential(workspace.credential).id).toBe(workspace.member.id);
    expect((service.cli as any).lastLaunchArgs.join(' ')).toContain(`arcp knowledge add ${workspace.workspace.id}`);
    expect((service.cli as any).lastLaunchArgs.join(' ')).toContain(`arcp result submit ${workspace.workspace.id}`);
    const launchArgs = (service.cli as any).lastLaunchArgs as string[]; expect(launchArgs).toContain('--env'); expect(launchArgs.some((arg) => arg.startsWith('ARCP_RUNTIME_MEMBER_CREDENTIAL='))).toBe(false); expect(launchArgs.some((arg) => arg.startsWith('ARCP_CLIENT_STATE=') && arg.includes('/runtime-members/'))).toBe(true);
  });
  it('maps Hermes ACP turn-end events to the existing idle observation and safe-point event', async () => {
    const process = new FakeAcpProcess(); const adapter = new HermesAcpAdapter(() => process as any); const launched = await adapter.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, 'canary', '.');
    const events: any[] = []; const facts: any[] = []; adapter.onSafePoint((event) => events.push(event)); adapter.onFact((fact) => facts.push(fact)); process.update('agent_message_chunk');
    expect((await adapter.observe(String((launched.value as any).id))).value).toMatchObject({ status: 'running', activeTurn: true, lastTurnState: 'running' }); process.update('requires_action');
    expect((await adapter.observe(String((launched.value as any).id))).value).toMatchObject({ status: 'attention', activeTurn: false, lastTurnState: 'requires_action' }); process.permission(); expect(facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(['permission', 'attention'])); process.update('turn_completed');
    expect((await adapter.observe(String((launched.value as any).id))).value).toMatchObject({ status: 'idle', activeTurn: false, lastTurnState: 'idle' }); expect(events.at(-1)).toMatchObject({ externalId: 'acp-session-1', state: 'idle' }); await adapter.interrupt(String((launched.value as any).id), 'cancel'); expect((await adapter.observe(String((launched.value as any).id))).value).toMatchObject({ status: 'idle', lastTurnState: 'idle' });
  });
  it('does not replay an ACP delivery after the subprocess is lost mid-turn', async () => {
    const process = new FakeAcpProcess(); const adapter = new HermesAcpAdapter(() => process as any); const launched = await adapter.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, 'loss', '.'); const sessionId = String((launched.value as any).id);
    const turn = adapter.startTurn(sessionId, 'one turn', 'delivery-1'); process.kill(); await expect(turn).rejects.toThrow('Hermes ACP process exited');
    expect(process.promptCount).toBe(1); expect(await adapter.reconcileExternal(sessionId)).toBe(false); expect(process.promptCount).toBe(1);
  });
  it('persists an ACP-created Result and delivers its decision request to the manager channel', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-acp-result-')); const process = new FakeAcpProcess(); const adapter = new HermesAcpAdapter(() => process as any);
    const companion = { store: { dir: root }, postMessage: async () => ({}), deleteMessage: async () => ({}) }; const service = new ArcpService(companion as any, new FakeCli() as any, undefined, undefined, [adapter]); await service.init();
    const { actor, binding } = await service.registerActor({ clientIdentity: 'acp-result-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'ACP result' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'acp-worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'ACP goal', workspaceId: workspace.workspace.id }); const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'ACP task' }); await service.claimTask(task.id, worker.member.id, 0);
    const acp = await adapter.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, 'ACP result', '.'); const externalId = String((acp.value as any).id);
    await service.store.mutate((state: any) => { state.sessions.push({ id: 'manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }); state.sessions.push({ id: 'worker-runtime', actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', state: 'idle', externalId, createdAt: new Date().toISOString() }); });
    process.update('plan'); process.update('agent_message_chunk'); process.update('turn_completed'); process.update('result', { result: { taskId: task.id, status: 'candidate', summary: 'ACP candidate', expectedFence: 1 } }); process.update('result', { result: { taskId: task.id, status: 'candidate', summary: 'ACP candidate', expectedFence: 1 } }); await new Promise((resolve) => setTimeout(resolve, 30));
    const state = service.state(); const progressEvents = state.channelEvents.filter((event) => ['phase_progress', 'material_progress', 'phase_completed'].includes(event.kind)); expect(progressEvents.map((event) => event.kind)).toEqual(expect.arrayContaining(['phase_progress', 'material_progress', 'phase_completed'])); expect(progressEvents.every((event) => event.goalId === goal.id && event.taskId === task.id)).toBe(true); expect(state.results).toHaveLength(1); const candidate = state.channelEvents.find((event) => event.kind === 'task_candidate'); const decision = state.channelEvents.find((event) => event.kind === 'decision_required'); expect(state.channelEvents.filter((event) => event.kind === 'task_candidate')).toHaveLength(1); expect(state.channelEvents.filter((event) => event.kind === 'decision_required')).toHaveLength(1); expect(candidate?.resultId).toBe(state.results[0].id); expect(decision?.relatedEventId).toBe(candidate?.id); const managerDelivery = state.deliveries.find((delivery) => delivery.eventId === decision?.id && delivery.runtimeSessionId === 'manager-runtime'); expect(managerDelivery).toBeDefined(); expect(decision?.transitions[0].state).toBe('queued'); await service.observe('manager-runtime'); await service.acknowledge(managerDelivery!.id, 'read'); expect(service.state().channelEvents.find((event) => event.id === decision?.id)?.transitions.map((entry) => entry.state)).toEqual(['queued', 'delivered', 'processed', 'acknowledged']); await expect(service.resolveDecision(decision!.id, workspace.member.id)).rejects.toMatchObject({ code: 'unauthorized' }); expect(await service.resolveDecision(decision!.id, manager.member.id)).toMatchObject({ kind: 'decision_resolved', relatedEventId: decision!.id }); const sourceId = `acp:${externalId}:${task.id}:1:candidate:ACP candidate`; const foreignWorkspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'foreign result' }); const foreignWorker = await service.joinWorkspace({ workspaceId: foreignWorkspace.workspace.id, label: 'foreign-worker', role: 'worker' }); const foreignTask = await service.createTask({ workspaceId: foreignWorkspace.workspace.id, title: 'foreign task' }); await service.claimTask(foreignTask.id, foreignWorker.member.id, 0); await expect(service.submitResult({ workspaceId: foreignWorkspace.workspace.id, taskId: foreignTask.id, memberId: foreignWorker.member.id, status: 'candidate', summary: 'foreign collision', expectedFence: 1, sourceId })).rejects.toMatchObject({ code: 'invalid_request', field: 'sourceId' });
    service.close();
  });
  it('deduplicates conflicting ChannelEvent ids and scopes member retrieval across target modes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-targets-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'channel-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'targets' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker', capabilities: ['worker-subscription'] });
        const stable = await service.publishChannelEvent({ id: 'event-stable', workspaceId: workspace.workspace.id, targetRole: 'owner', kind: 'decision_required', urgency: 'normal', decisionRequired: true, summary: 'approve candidate', evidenceRefs: [] }); expect(stable.content.contentHash).toHaveLength(64); expect(stable.content.summary).toBe('approve candidate'); expect(stable.transitions).toEqual([{ state: 'queued', at: expect.any(String) }, { state: 'undeliverable', at: expect.any(String) }]); expect(stable.undeliverableReason).toBe('no live target runtime session'); await expect(service.publishChannelEvent({ id: 'event-stable', workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'conflict', evidenceRefs: [] })).rejects.toMatchObject({ code: 'invalid_request' }); for (const content of ['Authorization: Bearer abc', 'token=abc', 'path=/Users/private/file', 'file:///tmp/private', 'reason=hidden', '<assistant>transcript']) await expect(service.publishChannelEvent({ workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: content, evidenceRefs: [] })).rejects.toMatchObject({ code: 'invalid_request' }); const resolved = await service.resolveDecision('event-stable', workspace.member.id, 'approved'); expect(resolved).toMatchObject({ kind: 'decision_resolved', relatedEventId: 'event-stable' });
    await service.publishChannelEvent({ id: 'event-worker', workspaceId: workspace.workspace.id, targetMemberId: worker.member.id, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'worker update', evidenceRefs: [] }); await service.publishChannelEvent({ id: 'event-subscription', workspaceId: workspace.workspace.id, targetSubscription: 'worker-subscription', kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'subscription update', evidenceRefs: [] });
    expect(service.channelEvents(workspace.workspace.id, workspace.member.id).map((event) => event.id)).toEqual(expect.arrayContaining(['event-stable'])); expect(service.channelEvents(workspace.workspace.id, workspace.member.id).map((event) => event.id)).not.toEqual(expect.arrayContaining(['event-worker', 'event-subscription'])); expect(service.channelEvents(workspace.workspace.id, worker.member.id).map((event) => event.id)).toEqual(expect.arrayContaining(['event-worker', 'event-subscription']));
  });
  it('delivers failed and unknown Result outcomes to a manager-facing ChannelEvent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-result-outcomes-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'outcome-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'outcomes' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'outcomes', workspaceId: workspace.workspace.id }); await service.store.mutate((state: any) => state.sessions.push({ id: 'outcome-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }));
    for (const status of ['failed', 'unknown'] as const) { const task = await service.createTask({ workspaceId: workspace.workspace.id, title: status }); await service.claimTask(task.id, worker.member.id, 0); await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status, summary: `${status} result`, expectedFence: 1 }); }
    const state = service.state(); const outcomeEvents = state.channelEvents.filter((event) => event.kind === 'task_failed' || event.kind === 'task_unknown'); expect(outcomeEvents).toHaveLength(2); expect(state.deliveries.filter((delivery) => delivery.runtimeSessionId === 'outcome-manager-runtime' && outcomeEvents.some((event) => event.id === delivery.eventId))).toHaveLength(2); expect(outcomeEvents.filter((event) => event.taskId).every((event) => Boolean(event.resultId))).toBe(true); service.close();
  });
  it('records the complete ChannelEvent kind inventory with task/result linkage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-inventory-')); const service = await control(root); const kinds: any[] = ['decision_required', 'decision_resolved', 'task_claimed', 'task_candidate', 'task_completed', 'task_failed', 'task_unknown', 'phase_progress', 'phase_completed', 'blocker', 'finding', 'permission', 'attention', 'runtime_health', 'transport_uncertainty', 'material_progress'];
    for (const [index, kind] of kinds.entries()) await service.publishChannelEvent({ id: `inventory-${index}`, workspaceId: 'workspace-inventory', goalId: 'goal-inventory', taskId: 'task-inventory', resultId: kind.includes('task_') ? `result-${index}` : undefined, targetRole: 'manager', kind, urgency: kind === 'attention' || kind === 'permission' ? 'urgent' : 'normal', decisionRequired: kind === 'decision_required', summary: `inventory ${kind}`, evidenceRefs: [], relatedEventId: kind === 'decision_resolved' ? 'inventory-0' : undefined });
    const events = service.state().channelEvents; expect(new Set(events.map((event) => event.kind))).toEqual(new Set(kinds)); expect(events.every((event) => event.taskId === 'task-inventory' && (event.kind.startsWith('task_') ? Boolean(event.resultId) : true))).toBe(true); expect(events.find((event) => event.kind === 'decision_resolved')?.relatedEventId).toBe('inventory-0'); service.close();
  });
  it('resolves a candidate into task_completed and delivers that completion to the manager', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-task-complete-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'complete-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'completion' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'completion goal', workspaceId: workspace.workspace.id }); await service.store.mutate((state: any) => state.sessions.push({ id: 'completion-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() })); const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'complete me' }); await service.claimTask(task.id, worker.member.id, 0); await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'candidate complete', expectedFence: 1 }); const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required')!; await service.resolveDecision(decision.id, manager.member.id, 'accepted'); const state = service.state(); const completed = state.channelEvents.find((event) => event.kind === 'task_completed'); expect(state.tasks.find((item) => item.id === task.id)?.lifecycle).toBe('completed'); expect(completed).toMatchObject({ taskId: task.id, resultId: decision.resultId }); expect(state.deliveries.some((delivery) => delivery.runtimeSessionId === 'completion-manager-runtime' && delivery.eventId === completed?.id)).toBe(false); service.close();
  });
  it('emits blocker and finding events from Knowledge writes with workspace task references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-knowledge-events-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'knowledge-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'knowledge events' }); const goal = await service.createGoal({ actorId: actor.id, title: 'knowledge goal', workspaceId: workspace.workspace.id }); const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'knowledge task' }); await service.addKnowledge({ workspaceId: workspace.workspace.id, authorMemberId: workspace.member.id, kind: 'blocker', text: 'blocked', taskId: task.id, goalId: goal.id }); await service.addKnowledge({ workspaceId: workspace.workspace.id, authorMemberId: workspace.member.id, kind: 'evidence', text: 'evidence', taskId: task.id, goalId: goal.id }); const events = service.state().channelEvents.filter((event) => event.kind === 'blocker' || event.kind === 'finding'); expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'blocker', taskId: task.id, goalId: goal.id }), expect.objectContaining({ kind: 'finding', taskId: task.id, goalId: goal.id })])); service.close();
  });
  it('normalizes legacy ChannelEvents into separated journal content deterministically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-migrate-')); await writeFile(path.join(root, 'arcp-state.json'), JSON.stringify({ channelEvents: [{ id: 'legacy-event', workspaceId: 'workspace-1', kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'legacy finding', evidenceRefs: ['result-1'], deliveryState: 'processed', deliveredAt: '2026-01-01T00:00:01.000Z', processedAt: '2026-01-01T00:00:02.000Z' }] })); const store = new ArcpStore(root); await store.init(); const event: any = store.snapshot().channelEvents[0]; expect(event.summary).toBeUndefined(); expect(event.evidenceRefs).toBeUndefined(); expect(event.content).toMatchObject({ summary: 'legacy finding', evidenceRefs: ['result-1'], contentHash: expect.any(String) }); expect(event.transitions).toEqual([{ state: 'queued', at: '2026-01-01T00:00:01.000Z' }, { state: 'delivered', at: '2026-01-01T00:00:01.000Z' }, { state: 'processed', at: '2026-01-01T00:00:02.000Z' }]);
  });
  it('awaits synchronous transport uncertainty ChannelEvents before reconcile returns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-transport-events-')); const service = await control(root); const { actor, binding } = await service.registerActor({ clientIdentity: 'transport-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'transport' }); await service.store.mutate((state: any) => state.sessions.push({ id: 'dead-external', actorId: actor.id, goalId: 'missing-goal', bindingId: binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: workspace.workspace.id, memberId: workspace.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', state: 'running', externalId: 'dead-acp', createdAt: new Date().toISOString() })); const reconciled = await service.reconcile('dead-external'); expect(reconciled.state).toBe('transport_indeterminate'); expect(service.channelEvents(workspace.workspace.id).map((event) => event.kind)).toEqual(expect.arrayContaining(['runtime_health', 'transport_uncertainty'])); service.close();
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

describe('ARCP Slice A channel correctness', () => {
  it('uses the profile role for managed members and permits an explicit role', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-role-')), false, ['claude']);
    const { actor } = await service.registerActor({ clientIdentity: 'role-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'role routing' });
    const manager = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'manager task', profileId: 'claude-manager' });
    expect((manager as any).member.role).toBe('manager');
    const explicit = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'explicit role', profileId: 'claude-manager', role: 'on-call' });
    expect((explicit as any).member.role).toBe('on-call');
    service.close();
  });

  it('rejects broadcast notifications and routes only to live non-source sessions', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-routing-')));
    const { actor } = await service.registerActor({ clientIdentity: 'routing-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'routing' });
    const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    await service.store.mutate((state: any) => state.sessions.push(
      { id: 'live-manager', actorId: actor.id, goalId: 'goal-manager', bindingId: state.bindings[0].id, generation: 1, workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'live-manager', createdAt: new Date().toISOString() },
      { id: 'dead-worker', actorId: actor.id, goalId: 'goal-worker', bindingId: state.bindings[0].id, generation: 1, workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'terminal', externalId: 'dead-worker', createdAt: new Date().toISOString() },
    ));
    await expect(service.publishChannelEvent({ workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'broadcast', evidenceRefs: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, sourceMemberId: worker.member.id, targetRole: 'manager', kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'live routing', evidenceRefs: [] });
    expect(service.state().deliveries.filter((item) => item.eventId === event.id).map((item) => item.runtimeSessionId)).toEqual(['live-manager']);
    service.close();
  });

  it('marks events with no deliverable target terminal and normalizes provider turn states', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-terminal-')), false, ['codex'], { lastTurnState: 'usage_update' });
    const { actor } = await service.registerActor({ clientIdentity: 'terminal-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'terminal event' });
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetRole: 'owner', kind: 'decision_required', urgency: 'urgent', decisionRequired: true, summary: 'owner action', evidenceRefs: [] });
    expect(event.deliveryState).toBe('undeliverable');
    const goal = await service.createGoal({ actorId: actor.id, title: 'normalize' });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect((await service.observe(runtime.id)).lastTurnState).toBe('idle');
    service.close();
  });

  it('emits bounded Paseo permission and attention facts and supports delivery withdrawal', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-facts-')), false, ['codex'], { status: 'permission', pendingPermissions: [{ id: 'p1' }] });
    const { actor } = await service.registerActor({ clientIdentity: 'facts-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'facts' });
    const member = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'facts', workspaceId: workspace.workspace.id });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, workspaceId: workspace.workspace.id, memberId: member.member.id, profileId: 'codex-worker' });
    await service.runtimeStatus(runtime.id); await service.runtimeStatus(runtime.id);
    const facts = service.state().channelEvents.filter((item) => item.sourceMemberId === member.member.id && ['permission', 'attention'].includes(item.kind));
    expect(facts.map((item) => item.kind).sort()).toEqual(['attention', 'permission']);
    const event = await service.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: member.member.id, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'held', evidenceRefs: [], notify: false });
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'withdraw-me', fromActorId: actor.id, runtimeSessionId: runtime.id, generation: runtime.generation, body: 'held', command: 'normal', eventId: event.id, state: 'waiting_safe_point', createdAt: new Date().toISOString() }));
    expect((await service.withdraw('withdraw-me')).state).toBe('withdrawn');
    service.close();
  });

  it('does not replay an already-delivered event after service restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-restart-delivery-')); const first = await control(root);
    const { actor } = await first.registerActor({ clientIdentity: 'restart-owner' }); const goal = await first.createGoal({ actorId: actor.id, title: 'restart' });
    const runtime = await first.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    const delivery = await first.deliver({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'once' }) as any;
    expect(delivery.state).toBe('delivered'); expect((first.cli as any).sends).toBe(1); first.close();
    const second = await control(root); expect((second.cli as any).sends).toBe(0); expect(second.state().deliveries.find((item) => item.id === delivery.id)?.state).toBe('processed'); second.close();
  });
});

describe('ARCP HTTP and legacy compatibility', () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => { if (app) { app.service.close(); await new Promise<void>((resolve) => app!.server.close(() => resolve())); } app = undefined; delete process.env.ARCP_API_KEY; });
  it('protects v1 while retaining the unversioned companion health route', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-http-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/actors`)).status).toBe(401);
    const registered = await fetch(`${base}/v1/actors`, { method: 'POST', headers: { 'x-arcp-api-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify({ clientIdentity: 'legacy-owner' }) });
    expect(registered.status).toBe(201);
    expect(JSON.stringify(await registered.json())).not.toContain('externalId');
  });

  it('routes an authenticated legacy message to an ARCP runtime exactly once and never creates Companion transport', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-seam-')); process.env.ARCP_API_KEY = 'test-key';
    const cli = new FakeCli(); app = await createServer(new CompanionService(cli as any, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const registered = await app.arcp.registerActor({ clientIdentity: 'runtime-owner' });
    await app.arcp.store.mutate((state: any) => { state.sessions.push({ id: 'runtime-1', actorId: registered.actor.id, goalId: 'goal-1', bindingId: registered.binding.id, generation: 1, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', externalId: 'paseo-session-1', state: 'idle', createdAt: new Date().toISOString() }); });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const response = await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-actor-key': registered.credential! }, body: JSON.stringify({ to: 'paseo-session-1', from: 'spoofed-legacy-from', body: 'deliver safely', mode: 'ack' }) });
    expect(response.status).toBe(201); const projected: any = await response.json();
    expect(projected.delivery).toMatchObject({ transport: 'arcp' }); expect(cli.sends).toBe(0);
    const audit = app.service.getMessages({ to: 'paseo-session-1' })[0];
    expect(audit).toMatchObject({ from: 'spoofed-legacy-from', transportOwner: 'arcp', ownerDeliveryId: expect.any(String) });
    expect(app.arcp.state().deliveries).toHaveLength(1); expect(app.arcp.state().deliveries[0]).toMatchObject({ sourceMessageId: audit.id, fromActorId: registered.actor.id, body: expect.stringContaining(`<ack>arcp message ack ${audit.id}`) });
    await app.service['ensureMessageDelivery']('paseo-session-1');
    expect(app.arcp.state().deliveries).toHaveLength(1); expect(cli.sends).toBe(0);
    const reminder = await app.service.createReminder({ agentId: 'paseo-session-1', delaySeconds: 60, message: 'reminder safe point' });
    await app.service.store.updateReminder(reminder.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() }); await app.service.reconcileReminders();
    expect(app.service.getMessages({ to: 'paseo-session-1' }).at(-1)).toMatchObject({ promptKind: 'reminder', transportOwner: 'arcp' });
    expect(app.arcp.state().deliveries).toHaveLength(2); expect(cli.sends).toBe(0);
  });

  it('holds unauthenticated ARCP legacy addressing and strips injected internal delivery ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-auth-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const registered = await app.arcp.registerActor({ clientIdentity: 'owner' });
    await app.arcp.store.mutate((state: any) => { state.sessions.push({ id: 'runtime-1', actorId: registered.actor.id, goalId: 'goal-1', bindingId: registered.binding.id, generation: 1, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', externalId: 'bound-agent', state: 'idle', createdAt: new Date().toISOString() }); });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-api-key': 'test-key' }, body: JSON.stringify({ to: 'bound-agent', from: 'forged', body: 'no actor' }) })).status).toBe(409);
    const injected = await fetch(`${base}/v1/deliveries`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-actor-key': registered.credential! }, body: JSON.stringify({ runtimeSessionId: 'runtime-1', body: 'public body', sourceMessageId: 'legacy-message-id' }) });
    expect(injected.status).toBe(201); expect(app.arcp.state().deliveries[0]?.sourceMessageId).toBeUndefined();
    const externalSend = await fetch(`${base}/v1/external/runtime-1/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arcp-actor-key': registered.credential! }, body: JSON.stringify({ body: 'private external prompt' }) }); const externalSendBody: any = await externalSend.json(); expect(externalSend.status).toBe(200); expect(externalSendBody.body).toBeUndefined();
  });
  it('returns actionable v1 error messages, including the current task fence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-errors-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const registered = await app.arcp.registerActor({ clientIdentity: 'error-owner' }); const created = await app.arcp.createWorkspace({ ownerActorId: registered.actor.id, purpose: 'errors' });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-member-key': created.credential, 'content-type': 'application/json' };
    const missing = await fetch(`${base}/v1/tasks/missing/claim`, { method: 'POST', headers, body: '{}' }); const missingBody: any = await missing.json();
    expect(missing.status).toBe(409); expect(missingBody).toMatchObject({ code: 'unknown_recipient', message: expect.any(String) });
    const task = await app.arcp.createTask({ workspaceId: created.workspace.id, title: 'fenced' });
    const stale = await fetch(`${base}/v1/tasks/${task.id}/claim`, { method: 'POST', headers, body: JSON.stringify({ expectedFence: 999 }) }); const staleBody: any = await stale.json();
    expect(stale.status).toBe(409); expect(staleBody).toMatchObject({ code: 'stale_generation', message: expect.stringContaining('current fence is 0') });
    const absent = await fetch(`${base}/v1/tasks/${task.id}/claim`, { method: 'POST', headers, body: '{}' }); const absentBody: any = await absent.json();
    expect(absent.status).toBe(400); expect(absentBody).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('--expected-fence'), field: 'expectedFence' });
  });
  it('prevents an actor from stopping or reconciling an external runtime in another workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-external-auth-')); process.env.ARCP_API_KEY = 'test-key'; app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const firstActor = await app.arcp.registerActor({ clientIdentity: 'first-actor' }); const secondActor = await app.arcp.registerActor({ clientIdentity: 'second-actor' }); const first = await app.arcp.createWorkspace({ ownerActorId: firstActor.actor.id, purpose: 'first' }); const second = await app.arcp.createWorkspace({ ownerActorId: secondActor.actor.id, purpose: 'second' });
    await app.arcp.store.mutate((state: any) => { state.sessions.push({ id: 'foreign-external', actorId: secondActor.actor.id, goalId: 'foreign-goal', bindingId: secondActor.binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: second.workspace.id, memberId: second.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', state: 'idle', externalId: 'foreign-acp', createdAt: new Date().toISOString() }); });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-actor-key': firstActor.credential! }; const stop = await fetch(`${base}/v1/external/foreign-external/stop`, { method: 'POST', headers }); const reconcile = await fetch(`${base}/v1/external/foreign-external/reconcile`, { method: 'POST', headers }); expect(stop.status).toBe(404); expect(reconcile.status).toBe(404);
  });
  it('uses the spawned runtime client state for HTTP claim, Knowledge, Result, and manager delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-spawned-http-')); const workerService = await control(root); const { actor } = await workerService.registerActor({ clientIdentity: 'spawned-manager' }); const workspace = await workerService.createWorkspace({ ownerActorId: actor.id, purpose: 'spawned worker' }); const manager = await workerService.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const managerGoal = await workerService.createGoal({ actorId: actor.id, title: 'manager runtime', workspaceId: workspace.workspace.id }); await workerService.launch({ actorId: actor.id, goalId: managerGoal.id, profileId: 'codex-worker', workspaceId: workspace.workspace.id, memberId: manager.member.id }); const started = await workerService.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'spawned task', profileId: 'codex-worker' }); const stateArg = ((workerService.cli as any).lastLaunchArgs as string[]).find((arg) => arg.startsWith('ARCP_CLIENT_STATE=')); expect(stateArg).toBeDefined(); const runtimeState: any = JSON.parse(await readFile(stateArg!.slice('ARCP_CLIENT_STATE='.length), 'utf8')); const runtimeCredential = runtimeState.runtimeMemberCredentials[started.session.id]; expect(runtimeCredential).toBeDefined();
    process.env.ARCP_API_KEY = 'test-key'; app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve)); const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const memberHeaders = { 'x-arcp-member-key': runtimeCredential, 'content-type': 'application/json' }; const claim = await fetch(`${base}/v1/tasks/${started.task.id}/claim`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ expectedFence: 0 }) }); expect(claim.status).toBe(200); const knowledge = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/knowledge`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ kind: 'evidence', text: 'spawned runtime evidence' }) }); expect(knowledge.status).toBe(201); const submitted = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/results`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ taskId: started.task.id, status: 'candidate', summary: 'spawned candidate', expectedFence: 1 }) }); expect(submitted.status).toBe(201); const managerContext = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/context`, { headers: { 'x-arcp-member-key': manager.credential! } }); const view: any = await managerContext.json(); expect(managerContext.status).toBe(200); expect(view.results.some((result: any) => result.taskId === started.task.id && result.memberId === started.member.id)).toBe(true); expect(view.events.some((event: any) => event.kind === 'decision_required' && event.taskId === started.task.id && event.resultId)).toBe(true); expect(view.inbox.some((delivery: any) => delivery.eventId)).toBe(true); workerService.close();
  });
  it('lists ControlWorkspace resources with member scoping and redaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-lists-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const owner = await app.arcp.registerActor({ clientIdentity: 'list-owner' }); const first = await app.arcp.createWorkspace({ ownerActorId: owner.actor.id, purpose: 'first' });
    const other = await app.arcp.createWorkspace({ ownerActorId: owner.actor.id, purpose: 'other' }); const task = await app.arcp.createTask({ workspaceId: first.workspace.id, title: 'listed' });
    await app.arcp.addKnowledge({ workspaceId: first.workspace.id, authorMemberId: first.member.id, kind: 'learning', text: 'visible learning' }); await app.arcp.claimTask(task.id, first.member.id, 0); await app.arcp.submitResult({ workspaceId: first.workspace.id, taskId: task.id, memberId: first.member.id, status: 'candidate', summary: 'visible result', expectedFence: 1 });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-member-key': first.credential };
    const get = async (url: string) => { const response = await fetch(`${base}${url}`, { headers }); return { status: response.status, body: await response.json() as any }; };
    expect((await get('/v1/workspaces')).body).toEqual([first.workspace]); expect((await get(`/v1/workspaces/${first.workspace.id}/tasks`)).body).toHaveLength(1);
    expect((await get(`/v1/workspaces/${first.workspace.id}/results`)).body).toHaveLength(1); const members = await get(`/v1/workspaces/${first.workspace.id}/members`); expect(members.body[0]).toMatchObject({ id: first.member.id }); expect(JSON.stringify(members.body)).not.toContain('credential');
    expect((await get(`/v1/workspaces/${first.workspace.id}/knowledge?q=`)).body).toHaveLength(1); expect((await get('/v1/goals')).status).toBe(200); expect((await get('/v1/runtime-sessions')).status).toBe(200);
    expect((await get(`/v1/workspaces/${other.workspace.id}/tasks`)).status).toBe(404);
    const foreignGoal = await app.arcp.createGoal({ actorId: owner.actor.id, title: 'foreign goal' });
    await app.arcp.store.mutate((state: any) => { state.sessions.push({ id: 'foreign-runtime', actorId: owner.actor.id, goalId: foreignGoal.id, bindingId: owner.binding.id, generation: 1, workspaceId: other.workspace.id, memberId: other.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', createdAt: new Date().toISOString() }); });
    expect((await get('/v1/goals')).body).toEqual([]); expect((await get('/v1/runtime-sessions')).body).toEqual([]);
  });
  it('filters channel events and requires member credentials for event ack and delivery withdrawal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-http-channel-')); app = await createServer(new CompanionService(undefined, new Store(root))); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const { actor } = await app.arcp.registerActor({ clientIdentity: 'http-channel' }); const workspace = await app.arcp.createWorkspace({ ownerActorId: actor.id, purpose: 'channel HTTP' }); const worker = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const manager = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const goal = await app.arcp.createGoal({ actorId: actor.id, title: 'channel runtime', workspaceId: workspace.workspace.id }); await app.arcp.store.mutate((state: any) => state.sessions.push({ id: 'http-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }));
        const event = await app.arcp.publishChannelEvent({ workspaceId: workspace.workspace.id, sourceMemberId: worker.member.id, targetRole: 'manager', kind: 'attention', urgency: 'urgent', decisionRequired: true, summary: 'manager attention', evidenceRefs: [], notify: false }); await app.arcp.store.mutate((state: any) => { const item = state.channelEvents.find((value: any) => value.id === event.id); item.deliveryState = 'delivered'; item.transitions.push({ state: 'delivered', at: new Date().toISOString() }); }); const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-member-key': manager.credential!, 'content-type': 'application/json' };
    const filtered = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/events?kind=attention&state=${event.deliveryState}&decision-required=true`, { headers }); expect(await filtered.json()).toEqual([expect.objectContaining({ id: event.id, kind: 'attention', decisionRequired: true })]);
    expect((await fetch(`${base}/v1/events/${event.id}/ack`, { method: 'POST', headers, body: JSON.stringify({ reason: 'seen' }) })).status).toBe(200); expect(app.arcp.state().channelEvents.find((item) => item.id === event.id)?.deliveryState).toBe('acknowledged');
    const held = await app.arcp.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'held delivery', evidenceRefs: [], notify: false }); await app.arcp.store.mutate((state: any) => state.deliveries.push({ id: 'http-withdraw', fromActorId: actor.id, runtimeSessionId: 'http-manager-runtime', generation: 1, body: 'held', command: 'normal', eventId: held.id, state: 'waiting_safe_point', createdAt: new Date().toISOString() }));
    expect((await fetch(`${base}/v1/deliveries/http-withdraw/withdraw`, { method: 'POST', headers, body: JSON.stringify({ reason: 'obsolete' }) })).status).toBe(200); expect(app.arcp.state().deliveries.find((item) => item.id === 'http-withdraw')?.state).toBe('withdrawn');
    expect((await fetch(`${base}/v1/events/${event.id}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});

describe('ARCP CLI and TUI presentation', () => {
  it('keeps two-word command parsing, payload booleans, auth, and HTTP exits deterministic', async () => {
    const seen: any[] = []; const server = await new Promise<http.Server>((resolve) => {
      const value = http.createServer(async (req: any, res: any) => { let body = ''; for await (const chunk of req) body += chunk; seen.push({ url: req.url, key: req.headers['x-arcp-api-key'], body: body ? JSON.parse(body) : undefined }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }); value.listen(0, '127.0.0.1', () => resolve(value));
    });
    const port = (server.address() as any).port; const script = path.join(process.cwd(), '../scripts/arcp');
    await execFileAsync(process.execPath, [script, 'idle', 'add', 'agent-1', 'nudge', '--threshold-percent', '0.8', '--once', 'true'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[0]).toMatchObject({ url: '/idle-reminders', key: 'cli-key', body: { agentId: 'agent-1', message: 'nudge', thresholdPercent: 0.8, once: true } });
    await execFileAsync(process.execPath, [script, 'knowledge', 'search', 'workspace-1', '--q', ''], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[1]).toMatchObject({ url: '/v1/workspaces/workspace-1/knowledge?q=&kind=&tag=', key: 'cli-key' });
    await expect(execFileAsync(process.execPath, [script, 'workspace', 'frobnicate'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command: frobnicate') });
    await expect(execFileAsync(process.execPath, [script, 'mystery'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command: mystery') });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(execFileAsync(process.execPath, [script, 'reminder', 'list'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}` } })).rejects.toMatchObject({ code: expect.any(Number) });
  });
  it('hands a managed runtime its per-runtime credential without clobbering the owner member', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-start-')); const statePath = path.join(stateDir, 'client.json'); await writeFile(statePath, JSON.stringify({ memberCredential: 'owner-secret', actorCredential: 'actor-secret' }));
    const seenKeys: string[] = []; const server = await new Promise<http.Server>((resolve) => { const value = http.createServer(async (req, res) => { seenKeys.push(String(req.headers['x-arcp-member-key'] ?? '')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ session: { id: 'runtime-1' }, credential: 'managed-secret' })); }); value.listen(0, '127.0.0.1', () => resolve(value)); });
    const port = (server.address() as any).port; const script = path.join(process.cwd(), '../scripts/arcp'); const output = await execFileAsync(process.execPath, [script, 'start', '--workspace', 'workspace-1', '--title', 'managed'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } });
    expect(output.stdout).toContain('credentialStored'); expect(output.stdout).not.toContain('managed-secret'); const saved: any = JSON.parse(await readFile(statePath, 'utf8')); expect(saved.memberCredential).toBe('owner-secret'); expect(saved.runtimeMemberCredentials).toEqual({ 'runtime-1': 'managed-secret' });
    await execFileAsync(process.execPath, [script, 'task', 'claim', 'task-1', '--runtime', 'runtime-1', '--expected-fence', '0'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } }); await execFileAsync(process.execPath, [script, 'result', 'submit', 'workspace-1', '--runtime', 'runtime-1', '--task', 'task-1', '--summary', 'candidate', '--expected-fence', '1'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } }); expect(seenKeys.slice(1)).toEqual(['managed-secret', 'managed-secret']);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('renders a deterministic mutation-free TUI snapshot', () => {
    const snapshot = renderTuiSnapshot({ workspace: { purpose: 'canary', lifecycle: 'active' }, goals: [{}], tasks: [{}], roster: [{}], runtime: [{ session: { id: 'r1', provider: 'codex', model: 'gpt', state: 'idle' }, observation: { health: 'healthy', cache: { state: 'fresh' }, context: { ratio: 0.5 }, compaction: { status: 'none' } }, children: { items: [] }, workSummary: { dirty: false, diffstat: { files: 0 } } }], legacy: { reminders: { active: 1 }, messages: { pending: 2 }, trackedChildren: { total: 3 }, blockedGateCount: 0 } });
    expect(snapshot).toContain('ARCP TUI · canary'); expect(snapshot).toContain('Runtime r1'); expect(snapshot).toContain('Legacy reminders=1 messages=2'); expect(snapshot).not.toContain('\x1b[');
  });
});
