import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService, ArcpStore, CLAUDE_CACHE_DEFAULTS, PASEO_TITLE_LIMIT, paseoTitle } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createServer, resolveDataDir } from '../../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { renderTuiSnapshot, runTui } from '../../../../skills/agent-runtime-control-panel/runtime/src/tui.js';
import { HermesAcpAdapter } from '../../../../skills/agent-runtime-control-panel/runtime/src/hermes-acp.js';
import { PaseoCli, parseJson } from '../../../../skills/agent-runtime-control-panel/runtime/src/cli.js';
import { surfaceName } from '../../../../skills/agent-runtime-control-panel/runtime/src/execution-placement.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

const execFileAsync = promisify(execFile);

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
async function control(root: string, fail: boolean | string = false, providers = ['codex'], inspectValue: Record<string, unknown> = {}, modeClientFactory?: any, modeListing?: unknown, registryListing?: unknown) {
  const { service } = await createControl(root, { cli: new FakePaseoCli({ fail, providers, inspectValue, modeListing, registryListing }), modeClientFactory });
  return service;
}

describe('ARCP MVE control core', () => {
  it('keeps surface names compact and free of cooperation titles', () => {
    expect(surfaceName('main')).toBe('main');
    expect(surfaceName('working')).toBe('ARCP · working');
    expect(surfaceName('lane', { slug: 'Temporal Projection / P0' })).toBe('ARCP · lane · temporal-projection-p0');
    expect(surfaceName('candidate', { revision: 'EC60752C196534' })).toBe('ARCP · candidate · ec60752');
  });
  it('keeps same-checkout Tabs visible, gates a real writer session, and archives only an explicit disposable lane', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-execution-surface-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async (workspaceId: string) => ({ projectId: 'prj_default', workspaceId });
    const materialized = await service.materializeSurface({ checkout: process.cwd(), kind: 'lane', slug: 'disposable' });
    const laneCreate = (service.cli as any).calls.find((args: string[]) => args[0] === 'workspace' && args[1] === 'create' && args.includes('worktree')) as string[];
    expect(laneCreate[laneCreate.indexOf('--base') + 1]).not.toBe('HEAD');
    const { actor } = await service.registerActor({ clientIdentity: 'surface-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'surface result' });
    const shared = { actorId: actor.id, workspaceId: workspace.workspace.id, profileId: 'codex-worker', executionSurfaceId: materialized.surface.id, workspace: materialized.surface.checkout.path };
    const manager = await service.startManaged({ ...shared, title: 'integration tab', role: 'manager' }) as any;
    await service.startManaged({ ...shared, title: 'review tab', role: 'reviewer' });
    await service.startManaged({ ...shared, title: 'steward tab', role: 'steward' });
    const writer = await service.startManaged({ ...shared, title: 'disposable lane handoff', role: 'worker' }) as any;
    await expect(service.claimSurface(materialized.surface, 'not-a-runtime')).rejects.toMatchObject({ code: 'unknown_recipient' });
    await expect(service.claimSurface(materialized.surface, manager.session.id)).rejects.toMatchObject({ code: 'task_held' });
    expect(service.state().surfaceClaims[0]).toMatchObject({ runtimeSessionId: writer.session.id, holder: writer.session.id, active: true });
    await service.claimTask(writer.task.id, writer.member.id, 0);
    await service.submitResult({ workspaceId: workspace.workspace.id, taskId: writer.task.id, memberId: writer.member.id, status: 'candidate', summary: 'handoff complete', expectedFence: 1 });
    expect(service.state().executionSurfaces[0]).toMatchObject({ operationalState: 'accepted', visibilityState: 'visible' });
    expect(service.state().surfaceClaims[0]).toMatchObject({ active: false });
    expect(service.state().runtimeBindings).toEqual(expect.arrayContaining([expect.objectContaining({ runtimeSessionId: writer.session.id, visibilityState: 'visible' })]));
    const { actor: otherActor } = await service.registerActor({ clientIdentity: 'not-surface-owner' });
    await expect(service.archiveSurface(materialized.surface, { controlWorkspaceId: workspace.workspace.id, actorId: otherActor.id })).rejects.toMatchObject({ code: 'unauthorized' });
    await service.archiveSurface(materialized.surface, { controlWorkspaceId: workspace.workspace.id, actorId: actor.id });
    expect(service.state().executionSurfaces[0].visibilityState).toBe('archived');
    expect(service.state().runtimeBindings.every((binding) => binding.visibilityState === 'archived')).toBe(true);
    expect((service.cli as any).calls).toContainEqual(['workspace', 'archive', 'wks_lane_1', '--json']);
    const restored = await service.restoreSurface(materialized.surface, { controlWorkspaceId: workspace.workspace.id, actorId: actor.id });
    expect(restored).toMatchObject({ evidence: { adapterId: 'paseo', strategy: 'rematerialized', previous: { workspaceId: 'wks_lane_1' }, current: { workspaceId: 'wks_default' } }, surface: { visibilityState: 'visible', adapterBindings: { paseo: { workspaceId: 'wks_default' } } } });
    expect(service.state().runtimeBindings.every((binding) => binding.visibilityState === 'archived')).toBe(true);
    await expect(service.claimSurface(materialized.surface, writer.session.id)).resolves.toMatchObject({ active: true, holder: writer.session.id });
    expect(await service.materializeSurface({ checkout: materialized.surface.checkout.path, kind: 'working' })).toMatchObject({ surface: { id: materialized.surface.id, visibilityState: 'visible' } });
    service.close();
  });
  it('scopes Panorama execution facts to its ControlWorkspace compatibility scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-panorama-scope-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async (workspaceId: string) => ({ projectId: 'prj_default', workspaceId });
    const { actor } = await service.registerActor({ clientIdentity: 'panorama-owner' }); const first = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'first' }); const second = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'second' });
    const firstSurface = await service.materializeSurface({ checkout: process.cwd(), kind: 'working' });
    const secondSurface = await service.materializeSurface({ checkout: process.cwd(), kind: 'lane', slug: 'other' });
    await service.createTask({ workspaceId: first.workspace.id, title: 'first task', executionSurfaceId: firstSurface.surface.id });
    await service.createTask({ workspaceId: second.workspace.id, title: 'second task', executionSurfaceId: secondSurface.surface.id });
    expect((await service.panorama(first.workspace.id) as any).execution.surfaces.map((surface: any) => surface.id)).toEqual([firstSurface.surface.id]);
    service.close();
  });
  it('keeps semantic Paseo tab titles at the 200-character boundary without splitting Unicode', () => {
    expect(paseoTitle('manager', 'x'.repeat(190))).toBe(`MANAGER · ${'x'.repeat(190)}`);
    const long = paseoTitle('manager', `${'x'.repeat(189)}😀follow-up`);
    expect(long.length).toBeLessThanOrEqual(PASEO_TITLE_LIMIT); expect(long.startsWith('MANAGER · ')).toBe(true); expect(long).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('classifies a deterministic Paseo title rejection without calling transport uncertain', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-title-rejected-')), 'AGENT_CREATE_FAILED too_big config.title maximum 200');
    const { actor } = await service.registerActor({ clientIdentity: 'title-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'x'.repeat(400) });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect(runtime.state).toBe('attention'); expect(runtime.externalId).toBeUndefined();
    service.close();
  });
  it('parses Paseo’s documented workspace prelude followed by one JSON payload', async () => {
    const output = 'Using workspace wks_0e6198d7efcef5a2\n{"id":"paseo-agent-1"}\n';
    expect(parseJson(output)).toEqual({ id: 'paseo-agent-1' });
    const cli = new PaseoCli(process.execPath);
    await expect(cli.run(['-e', `process.stdout.write(${JSON.stringify(output)})`, '--', '--json'])).resolves.toMatchObject({ value: { id: 'paseo-agent-1' } });
  });
  it('rejects malformed mixed output for a Paseo JSON command', async () => {
    const output = 'Using workspace wks_0e6198d7efcef5a2\n{"id":"paseo-agent-1"}\nnot-json\n';
    expect(() => parseJson(output)).toThrow('malformed JSON after workspace prelude');
    const cli = new PaseoCli(process.execPath);
    await expect(cli.run(['-e', `process.stdout.write(${JSON.stringify(output)})`, '--', '--json'])).rejects.toThrow('malformed JSON after workspace prelude');
  });
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
    const joined = await service.joinWorkspace({ workspaceId: workspace.id, label: 'native-pi', role: 'reviewer', capabilities: ['claim_task', 'write_knowledge', 'submit_result', 'read_context'] });
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
    const handoff = (service.cli as any).lastLaunchArgs.join(' ');
    expect(handoff).toContain('skills/agent-runtime-control-panel/scripts/arcp');
    expect(handoff).toContain(`'knowledge' 'add' '${workspace.workspace.id}'`);
    expect(handoff).toContain(`'result' 'submit' '${workspace.workspace.id}'`);
    const launchArgs = (service.cli as any).lastLaunchArgs as string[]; expect(launchArgs).toContain('--env'); expect(launchArgs.some((arg) => arg.startsWith('ARCP_RUNTIME_MEMBER_CREDENTIAL='))).toBe(false); expect(launchArgs.some((arg) => arg.startsWith('ARCP_CLIENT_STATE=') && arg.includes('/runtime-members/'))).toBe(true);
  });
  it('round-trips requested Paseo Project, Workspace, and Agent identities while retaining the requested cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-placement-')); const service = await control(root, false, ['codex'], { agentId: 'paseo-session-1', projectId: 'prj_my-claude-plugins', workspaceId: 'wks_0e6198d7efcef5a2' });
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_my-claude-plugins', workspaceId: 'wks_0e6198d7efcef5a2' });
    const { actor } = await service.registerActor({ clientIdentity: 'placement-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'stable placement' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'placed task', profileId: 'codex-worker', paseoProjectId: 'prj_my-claude-plugins', paseoWorkspaceId: 'wks_0e6198d7efcef5a2', workspace: '/checkout/skills/agent-runtime-control-panel/runtime' }) as any;
    const args = (service.cli as any).lastLaunchArgs as string[];
    expect(args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2)).toEqual(['--workspace', 'wks_0e6198d7efcef5a2']);
    expect(args.slice(args.indexOf('--cwd'), args.indexOf('--cwd') + 2)).toEqual(['--cwd', '/checkout/skills/agent-runtime-control-panel/runtime']);
    expect(args).toEqual(expect.arrayContaining(['--title', 'WORKER · placed task', '--label', `arcp-runtime=${started.session.id}`, '--label', 'arcp-role=worker']));
    expect(started.session.placement).toEqual({ requested: { projectId: 'prj_my-claude-plugins', workspaceId: 'wks_0e6198d7efcef5a2', agentId: 'paseo-session-1' }, observed: { projectId: 'prj_my-claude-plugins', workspaceId: 'wks_0e6198d7efcef5a2', agentId: 'paseo-session-1', lifecycle: 'idle' }, status: 'PLACEMENT_MATCH' });
    service.close();
  });
  it('holds before launch when the explicit Paseo Project does not own the selected Workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-project-conflict-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'remote:github.com/other/repository', workspaceId: 'wks_0e6198d7efcef5a2' });
    const { actor } = await service.registerActor({ clientIdentity: 'project-conflict-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'project conflict' });
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'must not launch', profileId: 'codex-worker', paseoProjectId: 'remote:github.com/atomlink-ye/my-claude-plugins', paseoWorkspaceId: 'wks_0e6198d7efcef5a2' })).resolves.toMatchObject({ action: 'hold', launchable: false, why: 'PLACEMENT_MISMATCH: requested Paseo Project does not own the selected Workspace' });
    expect((service.cli as any).launches).toBe(0); expect(service.state().goals).toHaveLength(0); expect(service.state().sessions).toHaveLength(0);
    service.close();
  });
  it('persists one canonical Paseo placement per checkout and reuses it for related Tabs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-canonical-placement-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_plugins', workspaceId: 'wks_checkout' });
    const { actor } = await service.registerActor({ clientIdentity: 'canonical-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'canonical placement' });
    const first = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'writer lane', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_checkout', workspace: '/checkout' }) as any;
    const second = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'review lane', profileId: 'codex-worker', role: 'reviewer', workspace: '/checkout' }) as any;
    expect(service.state().workspaces[0].paseoPlacements).toEqual([{ checkout: '/checkout', projectId: 'prj_plugins', workspaceId: 'wks_checkout' }]);
    expect((service.cli as any).launches).toBe(2);
    expect((service.cli as any).lastLaunchArgs).toEqual(expect.arrayContaining(['--workspace', 'wks_checkout', '--cwd', '/checkout']));
    const panorama: any = await service.panorama(workspace.workspace.id);
    expect(panorama.placement).toEqual([expect.objectContaining({ controlWorkspaceId: workspace.workspace.id, projectId: 'prj_plugins', workspaceId: 'wks_checkout', checkout: '/checkout', tabs: expect.arrayContaining([expect.objectContaining({ runtimeId: first.session.id, role: 'worker', goal: 'writer lane' }), expect.objectContaining({ runtimeId: second.session.id, role: 'reviewer', goal: 'review lane' })]) })]);
    service.close();
  });
  it('rejects a second requested Workspace for an already canonical checkout before launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-placement-conflict-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async (id: string) => ({ projectId: 'prj_plugins', workspaceId: id });
    const { actor } = await service.registerActor({ clientIdentity: 'conflict-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'placement conflict' });
    await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'first', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_canonical', workspace: '/checkout' });
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'duplicate', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_duplicate', workspace: '/checkout' })).resolves.toMatchObject({ action: 'hold', launchable: false, why: expect.stringContaining('PLACEMENT_CONFLICT') });
    expect((service.cli as any).launches).toBe(1);
    service.close();
  });
  it('applies the canonical placement conflict gate to direct runtime launches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-direct-placement-conflict-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async (id: string) => ({ projectId: 'prj_plugins', workspaceId: id });
    const { actor } = await service.registerActor({ clientIdentity: 'direct-conflict-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'direct placement conflict' });
    await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'canonical launch', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_canonical', workspace: '/checkout' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'alternate entry', workspaceId: workspace.workspace.id });
    await expect(service.launch({ actorId: actor.id, goalId: goal.id, workspaceId: workspace.workspace.id, profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_duplicate', workspace: '/checkout' })).rejects.toMatchObject({ code: 'placement_conflict', message: expect.stringContaining('PLACEMENT_CONFLICT') });
    expect((service.cli as any).launches).toBe(1);
    service.close();
  });
  it('holds a managed launch when Paseo cannot resolve a canonical Project identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-placement-unresolved-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async () => ({ workspaceId: 'wks_unresolved' });
    const { actor } = await service.registerActor({ clientIdentity: 'unresolved-placement-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'unresolved placement' });
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'must hold', profileId: 'codex-worker', paseoWorkspaceId: 'wks_unresolved' })).resolves.toMatchObject({ action: 'hold', launchable: false, why: expect.stringContaining('PLACEMENT_UNRESOLVED') });
    expect((service.cli as any).launches).toBe(0); expect(service.state().goals).toHaveLength(0); expect(service.state().sessions).toHaveLength(0);
    service.close();
  });
  it('resolves a nested checkout to the repository root before creating a Paseo Project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-placement-root-')); const service = await control(root);
    const nested = process.cwd(); const repositoryRoot = path.dirname((await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: nested })).stdout.trim());
    await (service.adapter as any).materializePlacement({ checkout: nested, title: 'root project' });
    const create = (service.cli as any).calls.find((args: string[]) => args[0] === 'project' && args[1] === 'create') as string[] | undefined;
    expect(create).toEqual(['project', 'create', repositoryRoot, '--json']);
    service.close();
  });
  it('materializes one canonical placement for an ID-less managed launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-idless-placement-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'idless-placement-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'idless placement' });
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'materialize once', profileId: 'codex-worker' })).resolves.toMatchObject({ session: { placement: { requested: { projectId: 'prj_default', workspaceId: 'wks_default' } } } });
    expect((service.cli as any).calls.filter((args: string[]) => args[0] === 'workspace' && args[1] === 'create')).toHaveLength(1); expect((service.cli as any).launches).toBe(1);
    service.close();
  });
  it('launches without placement when implicit canonical materialization is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-placement-unavailable-')); const service = await control(root);
    (service.adapter as any).materializePlacement = async () => { throw new Error('Paseo unavailable'); };
    const { actor } = await service.registerActor({ clientIdentity: 'placement-unavailable-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'placement unavailable' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'steward fallback', profileId: 'codex-worker' }) as any;
    expect(started.session).toMatchObject({ placement: { unresolved: 'PLACEMENT_UNRESOLVED: canonical Paseo placement could not be materialized before launch', requested: {} } });
    expect((service.cli as any).launches).toBe(1);
    service.close();
  });
  it('reports a Paseo placement mismatch without calling it transport indeterminate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-mismatch-')); const service = await control(root, false, ['codex'], { agentId: 'paseo-session-1', workspaceId: 'wks_other' });
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_plugins', workspaceId: 'wks_expected' });
    const { actor } = await service.registerActor({ clientIdentity: 'mismatch-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'mismatch' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'mismatch task', profileId: 'codex-worker', paseoWorkspaceId: 'wks_expected' }) as any;
    expect(started.session).toMatchObject({ state: 'placement_mismatch', placement: { status: 'PLACEMENT_MISMATCH', requested: { workspaceId: 'wks_expected', agentId: 'paseo-session-1' }, observed: { workspaceId: 'wks_other', agentId: 'paseo-session-1' } } });
    service.close();
  });
  it('reconciles an archived Paseo Agent to terminal while retaining its placement history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-archived-')); const service = await control(root, false, ['codex'], {}, undefined, undefined, [{ id: 'paseo-session-1', status: 'archived', projectId: 'prj_plugins', workspaceId: 'wks_0e6198d7efcef5a2' }]);
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_plugins', workspaceId: 'wks_0e6198d7efcef5a2' });
    const { actor } = await service.registerActor({ clientIdentity: 'archive-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'archive' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'archived task', profileId: 'codex-worker', paseoWorkspaceId: 'wks_0e6198d7efcef5a2' }) as any;
    const reconciled = await service.reconcile(started.session.id);
    expect(reconciled).toMatchObject({ id: started.session.id, state: 'terminal', placement: { requested: { projectId: 'prj_plugins', workspaceId: 'wks_0e6198d7efcef5a2', agentId: 'paseo-session-1' }, observed: { projectId: 'prj_plugins', workspaceId: 'wks_0e6198d7efcef5a2', agentId: 'paseo-session-1', lifecycle: 'archived' }, status: 'PLACEMENT_MATCH' } });
    service.close();
  });
  it('treats a Paseo Agent absent from the active registry as terminal without uncertainty events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-parked-')); const service = await control(root, false, ['codex'], {}, undefined, undefined, []);
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_plugins', workspaceId: 'wks_parked' });
    const { actor } = await service.registerActor({ clientIdentity: 'parked-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'parked' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'parked task', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_parked' }) as any;
    const reconciled = await service.reconcile(started.session.id);
    expect(reconciled.state).toBe('terminal'); expect(service.state().sessions).toHaveLength(1); expect(service.channelEvents(workspace.workspace.id).map((event) => event.kind)).not.toEqual(expect.arrayContaining(['runtime_health', 'transport_uncertainty']));
    service.close();
  });
  it('reconciles an archived Agent missing from the active registry as terminal, not transport indeterminate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-paseo-archived-missing-')); const service = await control(root, false, ['codex'], { status: 'archived', projectId: 'prj_plugins', workspaceId: 'wks_checkout' }, undefined, undefined, []);
    (service.adapter as any).workspacePlacement = async () => ({ projectId: 'prj_plugins', workspaceId: 'wks_checkout' });
    const { actor } = await service.registerActor({ clientIdentity: 'archive-missing-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'archive missing' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'archived missing task', profileId: 'codex-worker', paseoProjectId: 'prj_plugins', paseoWorkspaceId: 'wks_checkout' }) as any;
    expect(await service.reconcile(started.session.id)).toMatchObject({ id: started.session.id, state: 'terminal', placement: { status: 'PLACEMENT_MATCH', observed: { projectId: 'prj_plugins', workspaceId: 'wks_checkout', agentId: 'paseo-session-1', lifecycle: 'archived' } } });
    service.close();
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
    const service = new ArcpService(root, new FakePaseoCli() as any, undefined, undefined, [adapter]); await service.init();
    const { actor, binding } = await service.registerActor({ clientIdentity: 'acp-result-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'ACP result' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'acp-worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'ACP goal', workspaceId: workspace.workspace.id }); const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'ACP task' }); await service.claimTask(task.id, worker.member.id, 0);
    const acp = await adapter.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, 'ACP result', '.'); const externalId = String((acp.value as any).id);
    await service.store.mutate((state: any) => { state.sessions.push({ id: 'manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }); state.sessions.push({ id: 'worker-runtime', actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', state: 'idle', externalId, createdAt: new Date().toISOString() }); });
    process.update('plan'); process.update('agent_message_chunk'); process.update('turn_completed'); process.update('result', { result: { taskId: task.id, status: 'candidate', summary: 'ACP candidate', expectedFence: 1 } }); process.update('result', { result: { taskId: task.id, status: 'candidate', summary: 'ACP candidate', expectedFence: 1 } }); await service.flushResultSubmissions();
    const state = service.state(); const progressEvents = state.channelEvents.filter((event) => ['phase_progress', 'material_progress', 'phase_completed'].includes(event.kind)); expect(progressEvents.map((event) => event.kind)).toEqual(expect.arrayContaining(['phase_progress', 'material_progress', 'phase_completed'])); expect(progressEvents.every((event) => event.goalId === goal.id && event.taskId === task.id)).toBe(true); expect(state.results).toHaveLength(1); const candidate = state.channelEvents.find((event) => event.kind === 'task_candidate'); const decision = state.channelEvents.find((event) => event.kind === 'decision_required'); expect(state.channelEvents.filter((event) => event.kind === 'task_candidate')).toHaveLength(1); expect(state.channelEvents.filter((event) => event.kind === 'decision_required')).toHaveLength(1); expect(candidate?.resultId).toBe(state.results[0].id); expect(decision?.relatedEventId).toBe(candidate?.id); const managerDelivery = state.deliveries.find((delivery) => delivery.eventId === decision?.id && delivery.runtimeSessionId === 'manager-runtime'); expect(managerDelivery).toBeDefined(); expect(decision?.transitions[0].state).toBe('queued'); await service.observe('manager-runtime'); await service.acknowledge(managerDelivery!.id); expect(service.state().channelEvents.find((event) => event.id === decision?.id)?.transitions.map((entry) => entry.state)).toEqual(['queued', 'delivered', 'processed', 'acknowledged']); expect(await service.resolveDecision(decision!.id, workspace.member.id, 'approved', 'accept')).toMatchObject({ kind: 'decision_resolved', relatedEventId: decision!.id }); const sourceId = `acp:${externalId}:${task.id}:1:candidate:ACP candidate`; const foreignWorkspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'foreign result' }); const foreignWorker = await service.joinWorkspace({ workspaceId: foreignWorkspace.workspace.id, label: 'foreign-worker', role: 'worker' }); const foreignTask = await service.createTask({ workspaceId: foreignWorkspace.workspace.id, title: 'foreign task' }); await service.claimTask(foreignTask.id, foreignWorker.member.id, 0); await expect(service.submitResult({ workspaceId: foreignWorkspace.workspace.id, taskId: foreignTask.id, memberId: foreignWorker.member.id, status: 'candidate', summary: 'foreign collision', expectedFence: 1, sourceId })).rejects.toMatchObject({ code: 'invalid_request', field: 'sourceId' });
    await expect(service.publishChannelEvent({ workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'reason=hidden', evidenceRefs: [], notify: false })).resolves.toMatchObject({ kind: 'finding' });
    service.close();
  });
  it('deduplicates conflicting ChannelEvent ids and scopes member retrieval across target modes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-targets-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'channel-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'targets' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker', capabilities: ['worker-subscription'] });
        const stable = await service.publishChannelEvent({ id: 'event-stable', workspaceId: workspace.workspace.id, targetRole: 'owner', kind: 'decision_required', urgency: 'normal', decisionRequired: true, summary: 'approve candidate', evidenceRefs: [] }); expect(stable.content.contentHash).toHaveLength(64); expect(stable.content.summary).toBe('approve candidate'); expect(stable.transitions).toEqual([{ state: 'queued', at: expect.any(String) }, { state: 'undeliverable', at: expect.any(String) }]); expect(stable.undeliverableReason).toBe('no live target runtime session'); await expect(service.publishChannelEvent({ id: 'event-stable', workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: 'conflict', evidenceRefs: [] })).rejects.toMatchObject({ code: 'invalid_request' }); for (const content of ['Authorization: Bearer abc', 'token=abc', 'path=/Users/private/file', 'file:///tmp/private', 'reason=hidden', '<assistant>transcript']) await expect(service.publishChannelEvent({ workspaceId: workspace.workspace.id, kind: 'finding', urgency: 'normal', decisionRequired: false, summary: content, evidenceRefs: [] })).rejects.toMatchObject({ code: 'invalid_request' }); const resolved = await service.resolveDecision('event-stable', workspace.member.id, 'approved', 'accept'); expect(resolved).toMatchObject({ kind: 'decision_resolved', relatedEventId: 'event-stable' });
    await service.publishChannelEvent({ id: 'event-worker', workspaceId: workspace.workspace.id, targetMemberId: worker.member.id, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'worker update', evidenceRefs: [] }); await service.publishChannelEvent({ id: 'event-subscription', workspaceId: workspace.workspace.id, targetSubscription: 'worker-subscription', kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'subscription update', evidenceRefs: [] });
    expect(service.channelEvents(workspace.workspace.id, workspace.member.id).map((event) => event.id)).toEqual(expect.arrayContaining(['event-stable', 'event-worker', 'event-subscription'])); expect(service.channelEvents(workspace.workspace.id, worker.member.id).map((event) => event.id)).toEqual(expect.arrayContaining(['event-worker', 'event-subscription']));
  });
  it('lets the workspace owner resolve manager decisions and lets a targeted worker read and acknowledge blockers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-visibility-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'visibility-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'visibility' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const managerDecision = await service.publishChannelEvent({ id: 'manager-decision', workspaceId: workspace.workspace.id, targetRole: 'manager', kind: 'decision_required', urgency: 'normal', decisionRequired: true, summary: 'manager decision', evidenceRefs: [] });
    expect(service.channelEvents(workspace.workspace.id, workspace.member.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: managerDecision.id })]));
    await expect(service.resolveDecision(managerDecision.id, workspace.member.id, 'accepted', 'accept')).resolves.toMatchObject({ kind: 'decision_resolved', relatedEventId: managerDecision.id });
    await service.store.mutate((state: any) => state.sessions.push({ id: 'worker-visibility-runtime', actorId: actor.id, goalId: 'goal-visibility', bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'worker-visibility', createdAt: new Date().toISOString() }));
    const blocker = await service.addKnowledge({ workspaceId: workspace.workspace.id, authorMemberId: workspace.member.id, kind: 'blocker', text: 'worker blocker', targetMemberId: worker.member.id });
    const blockerEvent = service.state().channelEvents.find((event) => event.kind === 'blocker' && event.sourceMemberId === workspace.member.id && event.content.summary === `blocker knowledge ${blocker.id}`)!;
    expect(service.channelEvents(workspace.workspace.id, worker.member.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: blockerEvent.id, targetMemberId: worker.member.id })]));
    await expect(service.acknowledgeEvent(blockerEvent.id, worker.member.id)).resolves.toMatchObject({ id: blockerEvent.id, deliveryState: 'acknowledged' });
  });
  it('delivers failed and unknown Result outcomes to a manager-facing ChannelEvent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-result-outcomes-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'outcome-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'outcomes' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'outcomes', workspaceId: workspace.workspace.id }); await service.store.mutate((state: any) => state.sessions.push({ id: 'outcome-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }));
    for (const status of ['failed', 'unknown'] as const) { const task = await service.createTask({ workspaceId: workspace.workspace.id, title: status }); await service.claimTask(task.id, worker.member.id, 0); await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status, summary: `${status} result`, expectedFence: 1 }); }
    const state = service.state(); const outcomeEvents = state.channelEvents.filter((event) => event.kind === 'task_failed' || event.kind === 'task_unknown'); expect(outcomeEvents).toHaveLength(2); expect(state.deliveries.filter((delivery) => delivery.runtimeSessionId === 'outcome-manager-runtime' && outcomeEvents.some((event) => event.id === delivery.eventId))).toHaveLength(2); expect(outcomeEvents.filter((event) => event.taskId).every((event) => Boolean(event.resultId))).toBe(true); service.close();
  });
  it('records the complete ChannelEvent kind inventory with task/result linkage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-channel-inventory-')); const service = await control(root); const kinds: any[] = ['decision_required', 'decision_resolved', 'task_claimed', 'task_candidate', 'task_completed', 'task_failed', 'task_unknown', 'phase_progress', 'phase_completed', 'blocker', 'finding', 'permission', 'attention', 'runtime_health', 'transport_uncertainty', 'material_progress', 'workspace_analysis_required'];
    for (const [index, kind] of kinds.entries()) await service.publishChannelEvent({ id: `inventory-${index}`, workspaceId: 'workspace-inventory', goalId: 'goal-inventory', taskId: 'task-inventory', resultId: kind.includes('task_') ? `result-${index}` : undefined, targetRole: 'manager', kind, urgency: kind === 'attention' || kind === 'permission' ? 'urgent' : 'normal', decisionRequired: kind === 'decision_required', summary: `inventory ${kind}`, evidenceRefs: [], relatedEventId: kind === 'decision_resolved' ? 'inventory-0' : undefined });
    const events = service.state().channelEvents; expect(new Set(events.map((event) => event.kind))).toEqual(new Set(kinds)); expect(events.every((event) => event.taskId === 'task-inventory' && (event.kind.startsWith('task_') ? Boolean(event.resultId) : true))).toBe(true); expect(events.find((event) => event.kind === 'decision_resolved')?.relatedEventId).toBe('inventory-0'); service.close();
  });
  it('resolves a candidate into task_completed and delivers that completion to the manager', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-task-complete-')); const service = await control(root); const { actor } = await service.registerActor({ clientIdentity: 'complete-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'completion' }); const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const goal = await service.createGoal({ actorId: actor.id, title: 'completion goal', workspaceId: workspace.workspace.id }); await service.store.mutate((state: any) => state.sessions.push({ id: 'completion-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() })); const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'complete me' }); await service.claimTask(task.id, worker.member.id, 0); await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'candidate complete', expectedFence: 1 }); const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required')!; await service.resolveDecision(decision.id, manager.member.id, 'accepted', 'accept'); const state = service.state(); const completed = state.channelEvents.find((event) => event.kind === 'task_completed'); expect(state.tasks.find((item) => item.id === task.id)?.lifecycle).toBe('completed'); expect(completed).toMatchObject({ taskId: task.id, resultId: decision.resultId }); expect(state.deliveries.some((delivery) => delivery.runtimeSessionId === 'completion-manager-runtime' && delivery.eventId === completed?.id)).toBe(false); service.close();
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
  it('prefers ARCP_DATA, accepts the older state path name, and otherwise uses XDG state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-data-'));
    const prior = { arcp: process.env.ARCP_DATA, companion: process.env.PASEO_COMPANION_DATA, xdg: process.env.XDG_STATE_HOME };
    try {
      process.env.ARCP_DATA = root; process.env.PASEO_COMPANION_DATA = path.join(root, 'older');
      // Catches a mutation that reverses precedence between the two names.
      expect(resolveDataDir()).toBe(root);
      delete process.env.ARCP_DATA;
      // Catches a mutation that drops the older name and orphans an existing state directory.
      expect(resolveDataDir()).toBe(path.join(root, 'older'));
      delete process.env.PASEO_COMPANION_DATA; process.env.XDG_STATE_HOME = root;
      expect(resolveDataDir()).toBe(path.join(root, 'agent-runtime-control-panel/data'));
    } finally {
      for (const [name, value] of [['ARCP_DATA', prior.arcp], ['PASEO_COMPANION_DATA', prior.companion], ['XDG_STATE_HOME', prior.xdg]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
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

  it('uses a role as routing intent and explains the fixed provider selection without fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-role-routing-')); const service = await control(root, false, ['codex', 'claude', 'pi']);
    const worker = await service.preflight({ role: 'worker' });
    expect(worker).toMatchObject({ action: 'launch', profileId: 'codex-worker', routing: { roleIntent: 'worker', selection: 'role-intent', selectedProfile: { id: 'codex-worker', provider: 'codex', role: 'worker' } } });
    expect(worker.routing.alternatives).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'pi-grok-worker', provider: 'pi', reason: expect.stringContaining('select it explicitly') })]));
    const manager = await service.preflight({ role: 'manager' });
    expect(manager).toMatchObject({ action: 'launch', profileId: 'claude-manager', routing: { roleIntent: 'manager', selection: 'role-intent', selectedProfile: { provider: 'claude', role: 'manager' } } });
    const explicit = await service.preflight({ role: 'manager', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' });
    expect(explicit).toMatchObject({ action: 'launch', profileId: 'explicit', routing: { roleIntent: 'manager', selection: 'explicit-settings', selectedProfile: { provider: 'codex', role: 'explicit' }, alternatives: [] } });
    const unavailable = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-role-no-fallback-')), false, ['pi']);
    await expect(unavailable.preflight({ role: 'worker' })).resolves.toMatchObject({ action: 'hold', profileId: 'codex-worker', routing: { selection: 'role-intent' } });
    service.close(); unavailable.close();
  });

  it('uses public SDK mode ids over CLI human mode labels', async () => {
    const modeClient = () => ({ connect: async () => {}, close: async () => {}, providers: { listModes: async () => ({ provider: 'codex', modes: [{ id: 'auto' }, { id: 'auto-review' }, { id: 'full-access' }] }) } });
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sdk-modes-')); const service = await control(root, false, ['codex'], {}, modeClient, 'Default Permissions, Auto-review, Full Access');
    expect(await service.preflight({ profileId: 'codex-worker' })).toMatchObject({ action: 'launch', liveModes: ['auto', 'auto-review', 'full-access'] });
    const { actor } = await service.registerActor({ clientIdentity: 'sdk-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'SDK auto' });
    expect(await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' })).toMatchObject({ mode: 'auto', observed: { mode: 'auto' } });
  });

  it('keeps a nonempty SDK mode list authoritative over conflicting CLI labels', async () => {
    const modeClient = () => ({ connect: async () => {}, close: async () => {}, providers: { listModes: async () => ({ provider: 'codex', modes: [{ id: 'auto' }] }) } });
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sdk-authoritative-modes-')); const service = await control(root, false, ['codex'], {}, modeClient, 'Default Permissions, Auto-review, Full Access');
    expect(await service.preflight({ profileId: 'codex-full-access' })).toMatchObject({ action: 'hold', launchable: false, liveModes: ['auto'] });
  });

  it('falls back to CLI mode ids when SDK mode discovery returns an empty result', async () => {
    const modeClient = () => ({ connect: async () => {}, close: async () => {}, providers: { listModes: async () => ({ provider: 'codex', modes: [] }) } });
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-sdk-empty-modes-')); const service = await control(root, false, ['codex'], {}, modeClient, 'Default Permissions, Auto-review, Full Access');
    const preflight = await service.preflight({ profileId: 'codex-full-access' });
    expect(preflight).toMatchObject({ action: 'launch', launchable: true, liveModes: ['auto', 'auto-review', 'full-access'] });
    const { actor } = await service.registerActor({ clientIdentity: 'sdk-empty-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'SDK empty modes' });
    expect(await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-full-access' })).toMatchObject({ mode: 'full-access', observed: { mode: 'full-access' } });
  });

  it('allows only an explicit elevated profile and leaves Pi/Grok mode-less', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-elevated-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'approved disposable' });
    const elevated = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-full-access' });
    expect(elevated.mode).toBe('full-access'); expect(elevated.observed?.mode).toBe('full-access');
    const pi = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-')), false, ['pi']);
    expect(await pi.preflight({ profileId: 'pi-grok-worker' })).toMatchObject({ action: 'hold', launchable: false, requested: { provider: 'pi', model: 'grok-cli/grok-4.6' }, admission: { action: 'hold_unknown' } });
    await expect(pi.preflight({ provider: 'pi', model: 'grok-cli/grok-4.6', mode: 'auto' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('launches an explicitly admitted provider/model request and refuses non-live settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-explicit-parity-')); const service = await control(root);
    const admitted = await service.preflight({ provider: 'codex', model: 'GPT-5.6_TERRA', mode: 'AUTO', thinking: 'MEDIUM' });
    expect(admitted).toMatchObject({ action: 'launch', launchable: true, profileId: 'explicit', requested: { provider: 'codex', model: 'GPT-5.6_TERRA', mode: 'AUTO', thinking: 'MEDIUM' } });
    const { actor } = await service.registerActor({ clientIdentity: 'explicit-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'explicit parity' });
    const launched = await service.launch({ actorId: actor.id, goalId: goal.id, provider: 'codex', model: 'GPT-5.6_TERRA', mode: 'AUTO', thinking: 'MEDIUM' });
    expect(launched).toMatchObject({ profileId: 'explicit', provider: 'codex', model: 'GPT-5.6_TERRA', mode: 'AUTO', thinking: 'MEDIUM', state: 'idle' });
    expect((service.cli as any).lastLaunchArgs).toEqual(expect.arrayContaining(['--provider', 'codex', '--model', 'GPT-5.6_TERRA', '--mode', 'AUTO', '--thinking', 'MEDIUM']));
    const refused = await service.preflight({ provider: 'codex', model: 'not-a-live-model', mode: 'auto', thinking: 'medium' });
    expect(refused).toMatchObject({ action: 'hold', launchable: false, profileId: 'explicit' });
    const refusedGoal = await service.createGoal({ actorId: actor.id, title: 'refused explicit' });
    await expect(service.launch({ actorId: actor.id, goalId: refusedGoal.id, provider: 'codex', model: 'not-a-live-model', mode: 'auto', thinking: 'medium' })).rejects.toMatchObject({ code: 'profile_unavailable' });
    service.close();
  });

  it('uses the explicit profile resolution for a managed member role', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-explicit-managed-')); const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'explicit-managed-owner' }); const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'explicit managed' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'explicit managed runtime', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }) as any;
    expect(started).toMatchObject({ member: { role: 'worker' }, session: { profileId: 'explicit', provider: 'codex', model: 'gpt-5.6-terra' } });
    service.close();
  });

  it('keeps one launch receipt identity across bindings, observation, reconciliation, and facts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-launch-receipt-')); const service = await control(root);
    (service.adapter as any).workspacePlacement = async (workspaceId: string) => ({ projectId: 'prj_default', workspaceId });
    const surface = await service.materializeSurface({ checkout: process.cwd(), kind: 'working' });
    const { actor } = await service.registerActor({ clientIdentity: 'receipt-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'receipt identity' });
    const launched = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker', executionSurfaceId: surface.surface.id });
    const receipt = launched.externalId!;
    expect(service.state().runtimeBindings).toEqual(expect.arrayContaining([expect.objectContaining({ runtimeSessionId: launched.id, nativeId: receipt })]));
    expect(launched.placement).toMatchObject({ requested: { agentId: receipt } });
    await (service as any).facts(launched);
    await service.store.mutate((state: any) => { const session = state.sessions.find((item: any) => item.id === launched.id); delete session.externalId; delete session.placement.requested.agentId; });
    const observed = await service.observe(launched.id);
    expect(observed.externalId).toBe(receipt);
    expect(observed.placement?.requested.agentId).toBe(receipt);
    expect(service.state().runtimeBindings.filter((binding) => binding.runtimeSessionId === launched.id).every((binding) => binding.nativeId === receipt)).toBe(true);
    expect((await service.reconcile(launched.id)).state).toBe('idle');
    service.close();
  });

  it('treats a healthy mode-less Pi snapshot as matching and preserves transport uncertainty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-pi-truth-')); const service = await control(root, false, ['pi']);
    const { actor, binding } = await service.registerActor({ clientIdentity: 'pi-truth-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'Pi truth' });
    await service.store.mutate((state: any) => { state.sessions.push({ id: 'pi-truth-runtime', actorId: actor.id, goalId: goal.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'pi-grok-worker', provider: 'pi', model: 'grok-cli/grok-4.6', placement: { requested: { agentId: 'paseo-session-1' } }, externalId: 'paseo-session-1', state: 'running', createdAt: new Date().toISOString() }); state.runtimeBindings.push({ id: 'pi-truth-binding', executionSurfaceId: 'pi-surface', runtimeSessionId: 'pi-truth-runtime', adapterId: 'paseo', nativeId: 'paseo-session-1', generation: 1, state: 'running', visibilityState: 'visible', createdAt: new Date().toISOString() }); });
    const observed = await service.observe('pi-truth-runtime'); const status = await service.runtimeStatus('pi-truth-runtime');
    expect(observed).toMatchObject({ state: 'idle', placement: { status: 'PLACEMENT_MATCH' } });
    expect(status.observation).toMatchObject({ health: 'healthy', mismatch: false, requested: { provider: 'pi', model: 'grok-cli/grok-4.6' }, observed: { provider: 'pi', model: 'grok-cli/grok-4.6' } });
    const unreachable = (service.adapter as any).snapshot; (service.adapter as any).snapshot = async () => { throw new Error('Paseo unreachable'); };
    const uncertain = await service.observe('pi-truth-runtime');
    expect(uncertain.state).toBe('transport_indeterminate');
    const uncertainStatus = await service.runtimeStatus('pi-truth-runtime');
    expect(uncertainStatus).toMatchObject({ session: { state: 'transport_indeterminate' }, observation: { status: 'transport_indeterminate', health: 'degraded' } });
    expect(service.state().runtimeBindings.find((item) => item.id === 'pi-truth-binding')?.state).toBe('transport_indeterminate');
    (service.adapter as any).snapshot = unreachable;
    service.close();
  });

  it('treats opaque Paseo placement IDs as exact values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-opaque-placement-')); const service = await control(root, false, ['codex'], { id: 'agent_a' });
    const launch = service.adapter.launch.bind(service.adapter);
    (service.adapter as any).launch = async (...args: any[]) => { const result = await launch(...args); return { ...result, value: { ...(result.value as any), id: 'agent-a' } }; };
    const { actor } = await service.registerActor({ clientIdentity: 'opaque-placement-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'opaque placement' });
    const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    expect(runtime.placement).toMatchObject({ requested: { agentId: 'agent-a' }, observed: { agentId: 'agent_a' }, status: 'PLACEMENT_MISMATCH' });
    service.close();
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
    expect(normal.action).toBe('hold'); expect(normal.recommendedCommands.join('\n')).toContain('arcp reuse'); expect(normal.deliveryId).toBeDefined(); expect(service.state().deliveries[0]).toMatchObject({ state: 'held', id: normal.deliveryId }); expect((service.cli as any).sends).toBe(0);
    const interrupt = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test' }) as any;
    expect(interrupt).toMatchObject({ action: 'hold' }); expect(service.state().deliveries).toHaveLength(1); expect(service.state().deliveries[0].state).toBe('held');
    (service.cli as any).inspectValue.activeTurn = { id: 'turn-b' };
    const stale = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test', confirmation: interrupt.confirmation }) as any;
    expect(stale).toMatchObject({ action: 'hold', why: expect.stringContaining('stale') }); expect((service.cli as any).sends).toBe(0);
    const retry = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test' }) as any;
    const sent = await service.interrupt({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'stop', reason: 'test', confirmation: retry.confirmation }) as any;
    expect(sent.state).toBe('delivered'); expect((service.cli as any).sends).toBe(1);
  });
  it('persists a stale-cache hold and releases it after a fresh observation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-held-release-')); const activity = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const service = await control(root, false, ['claude'], { lastUserMessageAt: activity });
    const { actor } = await service.registerActor({ clientIdentity: 'held-owner' }); const goal = await service.createGoal({ actorId: actor.id, title: 'held delivery' }); const runtime = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'claude-manager' });
    const held: any = await service.deliver({ fromActorId: actor.id, runtimeSessionId: runtime.id, body: 'release me' });
    expect(held).toMatchObject({ action: 'hold', deliveryId: expect.any(String) }); expect(service.state().deliveries).toHaveLength(1); expect(service.state().deliveries[0]).toMatchObject({ id: held.deliveryId, state: 'held' });
    (service.cli as any).inspectValue.lastUserMessageAt = new Date().toISOString();
    await expect(service.release(held.deliveryId)).resolves.toMatchObject({ id: held.deliveryId, state: 'delivered' });
  });
});

describe('ARCP Slice C behavioral blockers', () => {
  it('ships the arcp executable used by emitted acknowledgement commands', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), '../../../package.json'), 'utf8'));
    expect(packageJson.bin.arcp).toBe('./skills/agent-runtime-control-panel/scripts/arcp');
  });
  it('keeps TUI refresh projection-only and never requests a forced panorama', async () => {
    const input: any = new PassThrough(); input.isTTY = true; input.setRawMode = () => input;
    const output: any = new PassThrough(); output.isTTY = true;
    const refreshes: boolean[] = []; const run = runTui({ input, output, refreshMs: 60_000, fetchPanorama: async (refresh) => { refreshes.push(refresh); return { runtime: [] }; } });
    await new Promise<void>((resolve) => setImmediate(resolve)); input.write('r'); await new Promise<void>((resolve) => setImmediate(resolve)); input.write('q'); await run;
    expect(refreshes.every((refresh) => refresh === false)).toBe(true);
  });
});

describe('ARCP Channel history', () => {
  it('preserves held and queued delivery history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-retention-')); const store = new ArcpStore(root); await store.init();
    await store.mutate((state: any) => { state.deliveries = Array.from({ length: 205 }, (_, index) => ({ id: `delivery-${index}`, fromActorId: 'actor', runtimeSessionId: 'runtime', generation: 1, body: 'held', command: 'normal', state: index % 2 ? 'held' : 'waiting_safe_point', createdAt: new Date(1_000 + index).toISOString() })); });
    await store.prune(); expect(store.snapshot().deliveries).toHaveLength(205); expect(store.snapshot().deliveries.some((item) => item.state === 'held')).toBe(true);
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
    await service.store.mutate((state: any) => state.deliveries.push({ id: 'withdraw-delivered', fromActorId: actor.id, runtimeSessionId: runtime.id, generation: runtime.generation, body: 'already sent', command: 'normal', state: 'delivered', createdAt: new Date().toISOString() }));
    await expect(service.withdraw('withdraw-delivered')).rejects.toMatchObject({ code: 'invalid_request' });
    service.close();
  });

  it('authorizes non-terminal withdrawal for sender, owner, and manager members only within the workspace', async () => {
    const service = await control(await mkdtemp(path.join(os.tmpdir(), 'arcp-withdraw-auth-')));
    const { actor: ownerActor, binding } = await service.registerActor({ clientIdentity: 'withdraw-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: ownerActor.id, purpose: 'withdraw authorization' });
    const { actor: senderActor } = await service.registerActor({ clientIdentity: 'withdraw-sender' });
    const { actor: managerActor } = await service.registerActor({ clientIdentity: 'withdraw-manager' });
    const { actor: unrelatedActor } = await service.registerActor({ clientIdentity: 'withdraw-unrelated' });
    const sender = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'sender', role: 'worker', actorId: senderActor.id });
    const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager', actorId: managerActor.id });
    const recipient = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'recipient', role: 'worker' });
    const unrelated = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'unrelated', role: 'worker', actorId: unrelatedActor.id });
    const goal = await service.createGoal({ actorId: ownerActor.id, title: 'withdraw authorization', workspaceId: workspace.workspace.id });
    await service.store.mutate((state: any) => {
      state.sessions.push({ id: 'withdraw-recipient-runtime', actorId: recipient.member.actorId ?? 'recipient-runtime-actor', goalId: goal.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: recipient.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'withdraw-recipient-runtime', createdAt: new Date().toISOString() });
      for (const id of ['withdraw-sender', 'withdraw-manager', 'withdraw-owner', 'withdraw-unrelated']) state.deliveries.push({ id, fromActorId: senderActor.id, runtimeSessionId: 'withdraw-recipient-runtime', generation: 1, body: id, command: 'normal', state: 'waiting_safe_point', createdAt: new Date().toISOString() });
    });
    await expect(service.withdraw('withdraw-sender', 'sender withdrew', sender.member.id)).resolves.toMatchObject({ state: 'withdrawn' });
    await expect(service.withdraw('withdraw-manager', 'manager withdrew', manager.member.id)).resolves.toMatchObject({ state: 'withdrawn' });
    await expect(service.withdraw('withdraw-owner', 'owner withdrew', workspace.member.id)).resolves.toMatchObject({ state: 'withdrawn' });
    await expect(service.withdraw('withdraw-unrelated', 'unrelated attempt', unrelated.member.id)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.state().deliveries.find((item) => item.id === 'withdraw-unrelated')?.state).toBe('waiting_safe_point');
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
  it('awaits restart pump and distinguishes delivered history from waiting safe-point work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-restart-pump-')); const first = await control(root);
    const { actor } = await first.registerActor({ clientIdentity: 'restart-pump-owner' }); const goal = await first.createGoal({ actorId: actor.id, title: 'restart pump' }); const runtime = await first.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    await first.store.mutate((state: any) => { state.deliveries.push({ id: 'delivered-history', fromActorId: actor.id, runtimeSessionId: runtime.id, generation: runtime.generation, body: 'already sent', command: 'normal', state: 'delivered', createdAt: new Date().toISOString() }, { id: 'waiting-work', fromActorId: actor.id, runtimeSessionId: runtime.id, generation: runtime.generation, body: 'send once', command: 'normal', state: 'waiting_safe_point', createdAt: new Date().toISOString() }); }); first.close();
    const second = await control(root); expect((second.cli as any).sends).toBe(1); expect(second.state().deliveries.find((item) => item.id === 'delivered-history')?.state).toBe('processed'); expect(second.state().deliveries.find((item) => item.id === 'waiting-work')?.state).toBe('delivered'); second.close();
  });
});

describe('ARCP HTTP surface', () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => { if (app) { app.arcp.close(); await new Promise<void>((resolve) => app!.server.close(() => resolve())); } app = undefined; delete process.env.ARCP_API_KEY; });
  it('protects v1, keeps /health open, and serves nothing else outside /v1', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-http-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/actors`)).status).toBe(401);
    // The retired 8787 control plane must not be reachable on any verb.
    for (const [method, route] of [['GET', '/messages'], ['POST', '/messages'], ['GET', '/reminders'], ['POST', '/reminders'], ['POST', '/idle-reminders'], ['GET', '/children?agentId=a'], ['GET', '/heartbeats'], ['POST', '/compact-wake'], ['GET', '/context-usage'], ['POST', '/ledger'], ['POST', '/corrections'], ['GET', '/gate?managerId=a'], ['GET', '/wakeup-sources?agentId=a']] as const) {
      const response = await fetch(`${base}${route}`, { method, headers: { 'x-arcp-api-key': 'test-key', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect([method, route, response.status]).toEqual([method, route, 404]);
      expect([method, route, (await response.json()).code]).toEqual([method, route, 'not_found']);
    }
    expect((await fetch(`${base}/self/runtime`)).status).toBe(401);
    const registered = await fetch(`${base}/v1/actors`, { method: 'POST', headers: { 'x-arcp-api-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify({ clientIdentity: 'legacy-owner' }) });
    expect(registered.status).toBe(201);
    expect(JSON.stringify(await registered.json())).not.toContain('externalId');
  });



  it('returns actionable v1 error messages, including the current task fence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-errors-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-external-auth-')); process.env.ARCP_API_KEY = 'test-key'; app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const firstActor = await app.arcp.registerActor({ clientIdentity: 'first-actor' }); const secondActor = await app.arcp.registerActor({ clientIdentity: 'second-actor' }); const first = await app.arcp.createWorkspace({ ownerActorId: firstActor.actor.id, purpose: 'first' }); const second = await app.arcp.createWorkspace({ ownerActorId: secondActor.actor.id, purpose: 'second' });
    await app.arcp.store.mutate((state: any) => { state.sessions.push({ id: 'foreign-external', actorId: secondActor.actor.id, goalId: 'foreign-goal', bindingId: secondActor.binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: second.workspace.id, memberId: second.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', state: 'idle', externalId: 'foreign-acp', createdAt: new Date().toISOString() }); });
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-actor-key': firstActor.credential! }; const stop = await fetch(`${base}/v1/external/foreign-external/stop`, { method: 'POST', headers }); const reconcile = await fetch(`${base}/v1/external/foreign-external/reconcile`, { method: 'POST', headers }); expect(stop.status).toBe(404); expect(reconcile.status).toBe(404);
  });
  it('uses the spawned runtime client state for HTTP claim, Knowledge, Result, and manager delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-spawned-http-')); const workerService = await control(root); const { actor } = await workerService.registerActor({ clientIdentity: 'spawned-manager' }); const workspace = await workerService.createWorkspace({ ownerActorId: actor.id, purpose: 'spawned worker' }); const manager = await workerService.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' }); const managerGoal = await workerService.createGoal({ actorId: actor.id, title: 'manager runtime', workspaceId: workspace.workspace.id }); await workerService.launch({ actorId: actor.id, goalId: managerGoal.id, profileId: 'codex-worker', workspaceId: workspace.workspace.id, memberId: manager.member.id }); const started = await workerService.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'spawned task', profileId: 'codex-worker' }); const stateArg = ((workerService.cli as any).lastLaunchArgs as string[]).find((arg) => arg.startsWith('ARCP_CLIENT_STATE=')); expect(stateArg).toBeDefined(); const runtimeState: any = JSON.parse(await readFile(stateArg!.slice('ARCP_CLIENT_STATE='.length), 'utf8')); const runtimeCredential = runtimeState.runtimeMemberCredentials[started.session.id]; expect(runtimeCredential).toBeDefined();
    process.env.ARCP_API_KEY = 'test-key'; app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve)); const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const memberHeaders = { 'x-arcp-member-key': runtimeCredential, 'content-type': 'application/json' }; const claim = await fetch(`${base}/v1/tasks/${started.task.id}/claim`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ expectedFence: 0 }) }); expect(claim.status).toBe(200); const knowledge = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/knowledge`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ kind: 'evidence', text: 'spawned runtime evidence' }) }); expect(knowledge.status).toBe(201); const submitted = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/results`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ taskId: started.task.id, status: 'candidate', summary: 'spawned candidate', expectedFence: 1 }) }); expect(submitted.status).toBe(201); const managerContext = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/context`, { headers: { 'x-arcp-member-key': manager.credential! } }); const view: any = await managerContext.json(); expect(managerContext.status).toBe(200); expect(view.roster.length).toBeGreaterThan(0); expect(view.tasks.length).toBeGreaterThan(0); expect(view.knowledge.length).toBeGreaterThan(0); expect(view.results.some((result: any) => result.taskId === started.task.id && result.memberId === started.member.id)).toBe(true); expect(view.events.some((event: any) => event.kind === 'decision_required' && event.taskId === started.task.id && event.resultId)).toBe(true); expect(view.inbox.some((delivery: any) => delivery.eventId)).toBe(true); workerService.close();
  });
  it('lists ControlWorkspace resources with member scoping and redaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-lists-')); process.env.ARCP_API_KEY = 'test-key';
    app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-http-channel-')); app = await createServer(root); await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const { actor } = await app.arcp.registerActor({ clientIdentity: 'http-channel' }); const workspace = await app.arcp.createWorkspace({ ownerActorId: actor.id, purpose: 'channel HTTP' }); const worker = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' }); const manager = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const goal = await app.arcp.createGoal({ actorId: actor.id, title: 'channel runtime', workspaceId: workspace.workspace.id }); await app.arcp.store.mutate((state: any) => state.sessions.push({ id: 'http-manager-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, workspaceId: workspace.workspace.id, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'paseo-session-1', createdAt: new Date().toISOString() }));
        const event = await app.arcp.publishChannelEvent({ workspaceId: workspace.workspace.id, sourceMemberId: worker.member.id, targetRole: 'manager', kind: 'attention', urgency: 'urgent', decisionRequired: true, summary: 'manager attention', evidenceRefs: [], notify: false }); await app.arcp.store.mutate((state: any) => { const item = state.channelEvents.find((value: any) => value.id === event.id); item.deliveryState = 'delivered'; item.transitions.push({ state: 'delivered', at: new Date().toISOString() }); }); const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; const headers = { 'x-arcp-member-key': manager.credential!, 'content-type': 'application/json' };
    const filtered = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/events?kind=attention&state=${event.deliveryState}&decision-required=true`, { headers }); expect(await filtered.json()).toEqual([]);
    const decision = await app.arcp.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'decision_required', urgency: 'normal', decisionRequired: true, summary: 'manager decision', evidenceRefs: [], notify: false });
    const decisions = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/events?decision-required=true`, { headers }); expect(await decisions.json()).toEqual([expect.objectContaining({ id: decision.id, kind: 'decision_required', decisionRequired: true })]);
    expect((await fetch(`${base}/v1/events/${event.id}/ack`, { method: 'POST', headers, body: JSON.stringify({ reason: 'seen' }) })).status).toBe(200); expect(app.arcp.state().channelEvents.find((item) => item.id === event.id)?.deliveryState).toBe('acknowledged');
    const held = await app.arcp.publishChannelEvent({ workspaceId: workspace.workspace.id, targetMemberId: manager.member.id, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: 'held delivery', evidenceRefs: [], notify: false }); await app.arcp.store.mutate((state: any) => state.deliveries.push({ id: 'http-withdraw', fromActorId: actor.id, runtimeSessionId: 'http-manager-runtime', generation: 1, body: 'held', command: 'normal', eventId: held.id, state: 'waiting_safe_point', createdAt: new Date().toISOString() }));
    expect((await fetch(`${base}/v1/deliveries/http-withdraw/withdraw`, { method: 'POST', headers, body: JSON.stringify({ reason: 'obsolete' }) })).status).toBe(200); expect(app.arcp.state().deliveries.find((item) => item.id === 'http-withdraw')?.state).toBe('withdrawn');
    expect((await fetch(`${base}/v1/events/${event.id}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});

describe('ARCP CLI and TUI presentation', () => {
  it('keeps two-word command parsing, flag values, auth, retirement and HTTP exits deterministic', async () => {
    const seen: any[] = []; const server = await new Promise<http.Server>((resolve) => {
      const value = http.createServer(async (req: any, res: any) => { let body = ''; for await (const chunk of req) body += chunk; seen.push({ url: req.url, key: req.headers['x-arcp-api-key'], body: body ? JSON.parse(body) : undefined }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }); value.listen(0, '127.0.0.1', () => resolve(value));
    });
    const port = (server.address() as any).port; const script = path.join(process.cwd(), '../scripts/arcp');
    await execFileAsync(process.execPath, [script, 'task', 'create', 'workspace-1', '--title', 'two word payload'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[0]).toMatchObject({ url: '/v1/workspaces/workspace-1/tasks', key: 'cli-key', body: { title: 'two word payload' } });
    await execFileAsync(process.execPath, [script, 'knowledge', 'search', 'workspace-1', '--q', ''], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[1]).toMatchObject({ url: '/v1/workspaces/workspace-1/knowledge?q=&kind=&tag=', key: 'cli-key' });
    await execFileAsync(process.execPath, [script, 'channel', 'list', 'workspace-1', '--decision-required'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[2]).toMatchObject({ url: '/v1/workspaces/workspace-1/events?decision-required=1', key: 'cli-key' });
    await execFileAsync(process.execPath, [script, 'channel', 'list', 'workspace-1', '--decision-required', 'false'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    // Catches a mutation that forwards the raw flag value instead of normalizing it.
    expect(seen[3]).toMatchObject({ url: '/v1/workspaces/workspace-1/events?decision-required=0', key: 'cli-key' });
    await execFileAsync(process.execPath, [script, 'supervision', 'configure', 'workspace-1', '--review-after-ms', '5000', '--cooldown-ms', '60000', '--steward-profile', 'codex-worker', '--automatic', 'false'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    // supervision configure is a member-scoped write, like task claim and steward
    // analyze: it must not carry the admin key. Catches a mutation that drops the
    // memberOnly flag and would let the CLI configure a policy with only an admin key.
    expect(seen[4]).toMatchObject({ url: '/v1/workspaces/workspace-1/supervision', key: undefined, body: { reviewAfterMs: 5000, cooldownMs: 60000, stewardProfileId: 'codex-worker', automatic: false } });
    await execFileAsync(process.execPath, [script, 'supervision', 'status', 'workspace-1'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen[5]).toMatchObject({ url: '/v1/workspaces/workspace-1/supervision', key: 'cli-key' });
    await execFileAsync(process.execPath, [script, 'result', 'submit', 'workspace-1', '--task', 'task-1', '--summary', 'steward finding', '--expected-fence', '1', '--evidence', 'task-1,review-1', '--evidence', 'knowledge-1'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/workspaces/workspace-1/results', body: { taskId: 'task-1', summary: 'steward finding', expectedFence: 1, evidenceRefs: ['task-1', 'review-1', 'knowledge-1'] } });
    // The retired 8787 verbs must be unknown commands, not silent no-ops.
    for (const argv of [['reminder', 'list'], ['message', 'send', 'a', 'b', 'c'], ['idle', 'add', 'agent-1', 'nudge'], ['correction', 'list'], ['gate', 'manager-1'], ['ledger', 'list'], ['compact', 'agent-1', 'focus'], ['child', 'list', 'agent-1'], ['wakeup', 'list', 'agent-1'], ['heartbeat', 'list'], ['context', 'usage']]) {
      await expect(execFileAsync(process.execPath, [script, ...argv], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_API_KEY: 'cli-key', ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } }))
        .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining(`unknown command: ${argv[0]}`) });
    }
    expect(seen).toHaveLength(7);
    await expect(execFileAsync(process.execPath, [script, 'workspace', 'frobnicate'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command: frobnicate') });
    await expect(execFileAsync(process.execPath, [script, 'mystery'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_CLIENT_STATE: path.join(await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-')), 'client.json') } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command: mystery') });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(execFileAsync(process.execPath, [script, 'runtime', 'list'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}` } })).rejects.toMatchObject({ code: expect.any(Number) });
  });
  it('hands a managed runtime its per-runtime credential without clobbering the owner member', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'arcp-cli-start-')); const statePath = path.join(stateDir, 'client.json'); await writeFile(statePath, JSON.stringify({ memberCredential: 'owner-secret', actorCredential: 'actor-secret' }));
    const seenKeys: string[] = []; const seenBodies: any[] = []; const server = await new Promise<http.Server>((resolve) => { const value = http.createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; seenKeys.push(String(req.headers['x-arcp-member-key'] ?? '')); seenBodies.push(body ? JSON.parse(body) : undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ session: { id: 'runtime-1' }, credential: 'managed-secret' })); }); value.listen(0, '127.0.0.1', () => resolve(value)); });
    const port = (server.address() as any).port; const script = path.join(process.cwd(), '../scripts/arcp'); const output = await execFileAsync(process.execPath, [script, 'start', '--workspace', 'workspace-1', '--title', 'managed'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } });
    expect(output.stdout).toContain('credentialStored'); expect(output.stdout).not.toContain('managed-secret'); const saved: any = JSON.parse(await readFile(statePath, 'utf8')); expect(saved.memberCredential).toBe('owner-secret'); expect(saved.runtimeMemberCredentials).toEqual({ 'runtime-1': 'managed-secret' });
    await execFileAsync(process.execPath, [script, 'task', 'claim', 'task-1', '--runtime', 'runtime-1', '--expected-fence', '0'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } }); await execFileAsync(process.execPath, [script, 'result', 'submit', 'workspace-1', '--runtime', 'runtime-1', '--task', 'task-1', '--summary', 'candidate', '--expected-fence', '1', '--source-id', 'source-1'], { cwd: path.join(process.cwd(), '..'), env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: statePath } }); expect(seenKeys.slice(1)).toEqual(['managed-secret', 'managed-secret']); expect(seenBodies[2]).toMatchObject({ sourceId: 'source-1' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('renders a deterministic mutation-free TUI snapshot', () => {
    const snapshot = renderTuiSnapshot({ workspace: { purpose: 'canary', lifecycle: 'active' }, goals: [{}], tasks: [{}], roster: [{}], runtime: [{ session: { id: 'r1', provider: 'codex', model: 'gpt', state: 'idle' }, observation: { health: 'healthy', cache: { state: 'fresh' }, context: { ratio: 0.5 }, compaction: { status: 'none' } }, children: { items: [] }, workSummary: { dirty: false, diffstat: { files: 0 } } }] });
    expect(snapshot).toContain('ARCP TUI · canary'); expect(snapshot).toContain('Runtime r1'); expect(snapshot).toContain('context=0.50');
    // The retired reminder/message/correction counters must not reappear.
    expect(snapshot).not.toContain('Legacy'); expect(snapshot).not.toContain('\x1b[');
  });
});

describe('ARCP decision verdicts', () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => { if (app) { app.arcp.close(); await new Promise<void>((resolve) => app!.server.close(() => resolve())); } app = undefined; });

  async function candidateAwaitingDecision(root: string) {
    const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'verdict-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'verdicts' });
    const manager = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'judge me' });
    await service.claimTask(task.id, worker.member.id, 0);
    await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'candidate for judgement', expectedFence: 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.taskId === task.id)!;
    return { service, workspace, manager, worker, task, decision };
  }

  it('leaves the Task open when a decision is refused, and completes it only on accept', async () => {
    const refusedRoot = await mkdtemp(path.join(os.tmpdir(), 'arcp-verdict-refuse-'));
    const refused = await candidateAwaitingDecision(refusedRoot);
    expect(refused.service.state().tasks.find((item) => item.id === refused.task.id)?.lifecycle).toBe('waiting');
    const refusal = await refused.service.resolveDecision(refused.decision.id, refused.manager.member.id, 'rework the candidate', 'refuse');
    const afterRefusal = refused.service.state();
    expect(refusal).toMatchObject({ kind: 'decision_resolved', relatedEventId: refused.decision.id, verdict: 'refuse' });
    expect(afterRefusal.tasks.find((item) => item.id === refused.task.id)?.lifecycle).toBe('waiting');
    expect(afterRefusal.channelEvents.some((event) => event.kind === 'task_completed' && event.taskId === refused.task.id)).toBe(false);
    expect(afterRefusal.channelEvents.find((event) => event.id === refused.decision.id)).toMatchObject({ decisionRequired: false, verdict: 'refuse' });
    refused.service.close();

    // The verdict is durable, not an in-memory decoration of the reply.
    const reopened = await control(refusedRoot);
    expect(reopened.state().channelEvents.find((event) => event.id === refused.decision.id)?.verdict).toBe('refuse');
    expect(reopened.state().tasks.find((item) => item.id === refused.task.id)?.lifecycle).toBe('waiting');
    reopened.close();

    const accepted = await candidateAwaitingDecision(await mkdtemp(path.join(os.tmpdir(), 'arcp-verdict-accept-')));
    const acceptance = await accepted.service.resolveDecision(accepted.decision.id, accepted.manager.member.id, 'ship it', 'accept');
    const afterAcceptance = accepted.service.state();
    expect(acceptance).toMatchObject({ kind: 'decision_resolved', verdict: 'accept' });
    expect(afterAcceptance.tasks.find((item) => item.id === accepted.task.id)?.lifecycle).toBe('completed');
    expect(afterAcceptance.channelEvents.some((event) => event.kind === 'task_completed' && event.taskId === accepted.task.id)).toBe(true);
    accepted.service.close();
  });

  it('rejects a verdict it cannot judge with rather than silently accepting', async () => {
    const held = await candidateAwaitingDecision(await mkdtemp(path.join(os.tmpdir(), 'arcp-verdict-invalid-')));
    await expect(held.service.resolveDecision(held.decision.id, held.manager.member.id, 'maybe', 'steer' as any)).rejects.toMatchObject({ code: 'invalid_request', field: 'verdict' });
    expect(held.service.state().tasks.find((item) => item.id === held.task.id)?.lifecycle).toBe('waiting');
    expect(held.service.state().channelEvents.find((event) => event.id === held.decision.id)?.decisionRequired).toBe(true);
    held.service.close();
  });

  it('carries the refusal verdict through the HTTP resolve route', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-verdict-http-'));
    app = await createServer(root);
    await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const { actor } = await app.arcp.registerActor({ clientIdentity: 'verdict-http' });
    const workspace = await app.arcp.createWorkspace({ ownerActorId: actor.id, purpose: 'verdict HTTP' });
    const manager = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'manager', role: 'manager' });
    const worker = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const task = await app.arcp.createTask({ workspaceId: workspace.workspace.id, title: 'http judge me' });
    await app.arcp.claimTask(task.id, worker.member.id, 0);
    await app.arcp.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'http candidate', expectedFence: 1 });
    const decision = app.arcp.state().channelEvents.find((event) => event.kind === 'decision_required' && event.taskId === task.id)!;
    const headers = { 'x-arcp-member-key': manager.credential!, 'content-type': 'application/json' };
    const response = await fetch(`${base}/v1/events/${decision.id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ summary: 'not yet', verdict: 'refuse' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'decision_resolved', verdict: 'refuse' });
    expect(app.arcp.state().tasks.find((item) => item.id === task.id)?.lifecycle).toBe('waiting');
    const rejected = await fetch(`${base}/v1/events/${decision.id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ summary: 'nonsense', verdict: 'maybe' }) });
    expect(rejected.status).toBe(400);
  });
});

describe('ARCP blocked-on-decision visibility', () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => { if (app) { app.arcp.close(); await new Promise<void>((resolve) => app!.server.close(() => resolve())); } app = undefined; });

  async function runningRuntime(root: string) {
    const service = await control(root);
    const { actor } = await service.registerActor({ clientIdentity: 'blocked-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'blocked runtimes' });
    const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'blocked goal', workspaceId: workspace.workspace.id });
    const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'ask me something' });
    await service.claimTask(task.id, worker.member.id, 0);
    // A runtime waiting on an in-turn question looks exactly like this: the
    // provider turn is still open, so status alone cannot tell them apart.
    await service.store.mutate((state: any) => state.sessions.push({ id: 'blocked-runtime', actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra', state: 'running', lastTurnState: 'running', createdAt: new Date().toISOString() }));
    return { service, actor, workspace, worker, goal, task };
  }

  it('writes the blocked record when the question is raised, since status never shows it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-blocked-raise-'));
    const { service, workspace, worker, task } = await runningRuntime(root);
    expect(service.blockedRuntimes(workspace.workspace.id)).toEqual([]);

    const raised = await service.raiseDecision({ runtimeSessionId: 'blocked-runtime', question: 'Delete the stale branch or keep it?', options: ['delete', 'keep'] });
    expect(raised.event).toMatchObject({ kind: 'decision_required', decisionRequired: true, targetRole: 'owner', urgency: 'urgent', decisionOptions: ['delete', 'keep'] });
    expect(raised.event.content.summary).toBe('Delete the stale branch or keep it?');

    const parked = service.blockedRuntimes(workspace.workspace.id);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ runtimeSessionId: 'blocked-runtime', eventId: raised.event.id, question: 'Delete the stale branch or keep it?', options: ['delete', 'keep'], taskId: task.id });
    expect(parked[0].ageMs).toBeGreaterThanOrEqual(0);

    // The point of the record: the runtime is still reporting itself healthy.
    const blockedSession = service.state().sessions.find((item) => item.id === 'blocked-runtime')!;
    expect(blockedSession.state).toBe('running');
    expect(blockedSession.lastTurnState).toBe('running');
    expect(blockedSession.blockedSince).toEqual(expect.any(String));

    // Re-raising the same unanswered question must not multiply prompts.
    const again = await service.raiseDecision({ runtimeSessionId: 'blocked-runtime', question: 'Delete the stale branch or keep it?', options: ['delete', 'keep'] });
    expect(again.event.id).toBe(raised.event.id);
    expect(service.state().channelEvents.filter((event) => event.kind === 'decision_required' && event.taskId === task.id)).toHaveLength(1);
    await expect(service.raiseDecision({ runtimeSessionId: 'blocked-runtime', question: 'A different question entirely' })).rejects.toMatchObject({ code: 'invalid_request' });
    service.close();

    // The blocked record and its start time survive a restart, which is what
    // makes the age trustworthy after a crash.
    const reopened = await control(root);
    const survived = reopened.blockedRuntimes(workspace.workspace.id);
    expect(survived).toHaveLength(1);
    expect(survived[0].eventId).toBe(raised.event.id);
    expect(survived[0].options).toEqual(['delete', 'keep']);

    // Answering releases the runtime; refusing still leaves the Task open.
    const answered = await reopened.resolveDecision(raised.event.id, workspace.member.id, 'keep it for now', 'refuse');
    expect(answered).toMatchObject({ kind: 'decision_resolved', relatedEventId: raised.event.id, verdict: 'refuse' });
    expect(reopened.blockedRuntimes(workspace.workspace.id)).toEqual([]);
    expect(reopened.state().tasks.find((item) => item.id === task.id)?.lifecycle).toBe('claimed');
    expect(reopened.state().sessions.find((item) => item.id === 'blocked-runtime')?.blockedOnEventId).toBeUndefined();
    expect(worker.member.id).toBeDefined();
    reopened.close();
  });

  it('shows a blocked runtime and its age in panorama and the TUI, and shows nothing when none is blocked', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-blocked-visible-'));
    app = await createServer(root);
    const service = app.arcp;
    const { actor } = await service.registerActor({ clientIdentity: 'blocked-visible' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'blocked visibility' });
    const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'visible goal', workspaceId: workspace.workspace.id });
    await service.store.mutate((state: any) => state.sessions.push({ id: 'blocked-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra', state: 'running', lastTurnState: 'running', createdAt: new Date().toISOString() }));

    const clean = await service.panorama(workspace.workspace.id);
    expect(clean.blocked).toEqual([]);
    const cleanSnapshot = renderTuiSnapshot(clean);
    expect(cleanSnapshot).toContain('Blocked 0');
    expect(cleanSnapshot).not.toContain('BLOCKED on decision');

    const raised = await service.raiseDecision({ runtimeSessionId: 'blocked-runtime', question: 'Overwrite the release tag?', options: ['overwrite', 'abort'] });
    await service.store.mutate((state: any) => { state.sessions.find((item: any) => item.id === 'blocked-runtime').blockedSince = new Date(Date.now() - 91 * 60_000).toISOString(); });

    const view = await service.panorama(workspace.workspace.id);
    expect(view.blocked).toHaveLength(1);
    expect(view.blocked[0].eventId).toBe(raised.event.id);
    expect(view.blocked[0].ageMs).toBeGreaterThanOrEqual(91 * 60_000);
    const snapshot = renderTuiSnapshot(view);
    expect(snapshot).toContain(`BLOCKED on decision ${raised.event.id} age=91m options=2`);
    expect(snapshot).toContain('Blocked 1 · oldest 91m');
  });

  it('raises and answers a blocked decision over the HTTP surface and refuses private data in the options', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-blocked-http-'));
    app = await createServer(root);
    await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const { actor } = await app.arcp.registerActor({ clientIdentity: 'blocked-http' });
    const workspace = await app.arcp.createWorkspace({ ownerActorId: actor.id, purpose: 'blocked HTTP' });
    const worker = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'worker', role: 'worker' });
    const goal = await app.arcp.createGoal({ actorId: actor.id, title: 'blocked http goal', workspaceId: workspace.workspace.id });
    await app.arcp.store.mutate((state: any) => state.sessions.push({ id: 'http-blocked-runtime', actorId: actor.id, goalId: goal.id, bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: worker.member.id, profileId: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra', state: 'running', lastTurnState: 'running', createdAt: new Date().toISOString() }));
    const headers = { 'x-arcp-member-key': workspace.credential, 'content-type': 'application/json' };

    const rejected = await fetch(`${base}/v1/runtime-sessions/http-blocked-runtime/decision`, { method: 'POST', headers, body: JSON.stringify({ question: 'Which file do I keep?', options: ['keep /Users/private/notes.md', 'discard'] }) });
    expect(rejected.status).toBe(400);
    expect(app.arcp.blockedRuntimes(workspace.workspace.id)).toEqual([]);

    const raised = await fetch(`${base}/v1/runtime-sessions/http-blocked-runtime/decision`, { method: 'POST', headers, body: JSON.stringify({ question: 'Which branch do I keep?', options: ['mine', 'theirs'] }) });
    expect(raised.status).toBe(201);
    const raisedBody: any = await raised.json();
    expect(raisedBody.event).toMatchObject({ kind: 'decision_required', decisionRequired: true, decisionOptions: ['mine', 'theirs'] });
    expect(raisedBody.session.blockedOnEventId).toBe(raisedBody.event.id);
    expect(JSON.stringify(raisedBody)).not.toContain('externalId');

    const panorama: any = await (await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/panorama`, { headers })).json();
    expect(panorama.blocked).toEqual([expect.objectContaining({ runtimeSessionId: 'http-blocked-runtime', eventId: raisedBody.event.id, options: ['mine', 'theirs'] })]);

    const resolved = await fetch(`${base}/v1/events/${raisedBody.event.id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ summary: 'keep mine', verdict: 'accept' }) });
    expect(resolved.status).toBe(200);
    const after: any = await (await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/panorama`, { headers })).json();
    expect(after.blocked).toEqual([]);
  });
});
