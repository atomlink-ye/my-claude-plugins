import { mkdtemp, readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createServer } from '../../../../skills/agent-runtime-control-panel/runtime/src/server.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

const execFileAsync = promisify(execFile);

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
    const runtimeStatePath = path.join(root, 'runtime-members', `${started.session.id}-g${started.session.generation}.json`);
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
    expect(runtimeState).toMatchObject({ runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation, runtimeMemberCredentials: { [started.session.id]: started.credential } });
    const claimed = await service.claimTask(started.task.id, started.member.id, 0);
    const replaced = await service.replaceRuntime({ runtimeSessionId: started.session.id, profileId: 'codex-worker' });
    const replacementStatePath = path.join(root, 'runtime-members', `${started.session.id}-g${replaced.generation}.json`);
    expect(JSON.parse(await readFile(runtimeStatePath, 'utf8'))).toMatchObject({ runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation });
    expect(JSON.parse(await readFile(replacementStatePath, 'utf8'))).toMatchObject({ runtimeSessionId: started.session.id, runtimeGeneration: replaced.generation });

    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: claimed.id, memberId: started.member.id, status: 'candidate', summary: 'stale result', expectedFence: 1, runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation })).rejects.toMatchObject({ code: 'stale_generation' });
    const current = await service.submitResult({ workspaceId: workspace.workspace.id, taskId: claimed.id, memberId: started.member.id, status: 'candidate', summary: 'current result', expectedFence: 1, runtimeSessionId: replaced.id, runtimeGeneration: replaced.generation });
    expect(current).toMatchObject({ runtimeSessionId: replaced.id, runtimeGeneration: replaced.generation, summary: 'current result' });
    service.close();
  });

  it('requires managed runtime provenance for Result submission, including after replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-result-provenance-'));
    const { service } = await createControl(root, { cli: new FakePaseoCli({ inspectValue: { id: 'runtime-provenance-1' } }) });
    const { actor } = await service.registerActor({ clientIdentity: 'result-provenance-owner' });
    const workspace = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'result provenance' });
    const started = await service.startManaged({ actorId: actor.id, workspaceId: workspace.workspace.id, title: 'provenance result', profileId: 'codex-worker' }) as any;
    await service.claimTask(started.task.id, started.member.id, 0);

    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'missing provenance', expectedFence: 1 })).rejects.toMatchObject({ code: 'invalid_request', field: 'runtimeSessionId' });
    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'missing generation', expectedFence: 1, runtimeSessionId: started.session.id })).rejects.toMatchObject({ code: 'invalid_request', field: 'runtimeGeneration' });
    expect(service.state().results).toHaveLength(0);
    expect(service.state().channelEvents.filter((event) => ['task_candidate', 'decision_required'].includes(event.kind))).toHaveLength(0);

    await service.replaceRuntime({ runtimeSessionId: started.session.id, profileId: 'codex-worker' });
    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'missing after replacement', expectedFence: 1 })).rejects.toMatchObject({ code: 'invalid_request', field: 'runtimeSessionId' });
    expect(service.state().results).toHaveLength(0);
    expect(service.state().channelEvents.filter((event) => ['task_candidate', 'decision_required'].includes(event.kind))).toHaveLength(0);

    await service.stopRuntime(started.session.id);
    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'missing after stop', expectedFence: 1 })).rejects.toMatchObject({ code: 'invalid_request', field: 'runtimeSessionId' });
    await expect(service.submitResult({ workspaceId: workspace.workspace.id, taskId: started.task.id, memberId: started.member.id, status: 'candidate', summary: 'terminal provenance', expectedFence: 1, runtimeSessionId: started.session.id, runtimeGeneration: started.session.generation + 1 })).rejects.toMatchObject({ code: 'stale_generation' });
    expect(service.state().results).toHaveLength(0);
    expect(service.state().channelEvents.filter((event) => ['task_candidate', 'decision_required'].includes(event.kind))).toHaveLength(0);
    service.close();
  });

  it('makes the runtime client state add immutable provenance to the real result CLI request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-result-cli-'));
    const clientStatePath = path.join(root, 'client.json');
    await writeFile(clientStatePath, JSON.stringify({ runtimeSessionId: 'runtime-cli', runtimeGeneration: 4, memberCredential: 'member-secret' }) + '\n');
    let request: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | undefined;
    const server = http.createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += String(chunk);
      request = { headers: req.headers, body: JSON.parse(text) };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', 'skills/agent-runtime-control-panel/scripts/arcp');
    await execFileAsync(process.execPath, [script, 'result', 'submit', 'workspace-cli', '--runtime', 'runtime-cli', '--task', 'task-cli', '--summary', 'from runtime', '--expected-fence', '1'], { env: { ...process.env, ARCP_URL: `http://127.0.0.1:${port}`, ARCP_CLIENT_STATE: clientStatePath, ARCP_API_KEY: '' } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(request?.headers['x-arcp-member-key']).toBe('member-secret');
    expect(request?.body).toMatchObject({ taskId: 'task-cli', runtimeSessionId: 'runtime-cli', runtimeGeneration: 4, summary: 'from runtime' });
  });

  it('rejects an HTTP Result omission for a managed runtime before creating Result state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-result-http-provenance-'));
    const app = await createServer(root);
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const { actor, binding } = await app.arcp.registerActor({ clientIdentity: 'http-result-provenance-owner' });
      const workspace = await app.arcp.createWorkspace({ ownerActorId: actor.id, purpose: 'HTTP result provenance' });
      const joined = await app.arcp.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'managed-worker', role: 'worker', joinKind: 'managed', actorId: actor.id });
      const goal = await app.arcp.createGoal({ actorId: actor.id, title: 'HTTP provenance goal', workspaceId: workspace.workspace.id });
      const task = await app.arcp.createTask({ workspaceId: workspace.workspace.id, title: 'HTTP provenance task' });
      await app.arcp.store.mutate((state: any) => state.sessions.push({ id: 'http-result-runtime', actorId: actor.id, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: workspace.workspace.id, memberId: joined.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', createdAt: new Date().toISOString() }));
      await app.arcp.claimTask(task.id, joined.member.id, 0);
      const address = app.server.address();
      const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      const response = await fetch(`${base}/v1/workspaces/${workspace.workspace.id}/results`, { method: 'POST', headers: { 'x-arcp-member-key': joined.credential!, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: task.id, status: 'candidate', summary: 'HTTP omission', expectedFence: 1 }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_request', field: 'runtimeSessionId' });
      expect(app.arcp.state().results).toHaveLength(0);
      expect(app.arcp.state().channelEvents.filter((event) => ['task_candidate', 'decision_required'].includes(event.kind))).toHaveLength(0);
    } finally {
      app.arcp.close();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  it('serializes concurrent replacements so only one successor generation launches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-generation-race-'));
    const { service } = await createControl(root, { cli: new FakePaseoCli() });
    const { actor } = await service.registerActor({ clientIdentity: 'generation-race-owner' });
    const goal = await service.createGoal({ actorId: actor.id, title: 'race replacement' });
    const first = await service.launch({ actorId: actor.id, goalId: goal.id, profileId: 'codex-worker' });
    const originalLaunch = (service.adapter as any).launch.bind(service.adapter);
    let replacementLaunches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (service.adapter as any).launch = async (...args: any[]) => { replacementLaunches += 1; await gate; return originalLaunch(...args); };
    const one = service.replaceRuntime({ runtimeSessionId: first.id, expectedGeneration: first.generation, profileId: 'codex-worker' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(service.replaceRuntime({ runtimeSessionId: first.id, expectedGeneration: first.generation, profileId: 'codex-worker' })).rejects.toSatisfy((error: any) => ['launch_held', 'stale_generation'].includes(error.code));
    release();
    await expect(one).resolves.toMatchObject({ id: first.id, generation: 2 });
    expect(replacementLaunches).toBe(1);
    expect(service.state().sessions).toHaveLength(1);
    service.close();
  });

  it('refuses caller-supplied runtime reuse across goal or actor ownership boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-generation-takeover-'));
    const { service } = await createControl(root, { cli: new FakePaseoCli() });
    const firstOwner = await service.registerActor({ clientIdentity: 'takeover-owner' });
    const firstGoal = await service.createGoal({ actorId: firstOwner.actor.id, title: 'original goal' });
    const first = await service.launch({ actorId: firstOwner.actor.id, goalId: firstGoal.id, profileId: 'codex-worker' });
    await service.stopRuntime(first.id);
    const otherGoal = await service.createGoal({ actorId: firstOwner.actor.id, title: 'other goal' });
    await expect(service.launch({ actorId: firstOwner.actor.id, goalId: otherGoal.id, runtimeId: first.id, expectedGeneration: first.generation, profileId: 'codex-worker' })).rejects.toMatchObject({ code: 'unauthorized' });
    const secondOwner = await service.registerActor({ clientIdentity: 'takeover-foreign-owner' });
    const foreignGoal = await service.createGoal({ actorId: secondOwner.actor.id, title: 'foreign goal' });
    await expect(service.launch({ actorId: secondOwner.actor.id, goalId: foreignGoal.id, runtimeId: first.id, expectedGeneration: first.generation, profileId: 'codex-worker' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(service.launch({ actorId: firstOwner.actor.id, goalId: firstGoal.id, runtimeId: first.id, profileId: 'codex-worker', replaceReserved: true } as any)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.launch({ actorId: firstOwner.actor.id, goalId: firstGoal.id, runtimeId: first.id, profileId: 'codex-worker' })).rejects.toMatchObject({ code: 'invalid_request' });
    service.close();
  });

  it('rejects member body actor forgery and public reservation markers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-runtime-generation-http-'));
    const app = await createServer(root);
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const first = await app.arcp.registerActor({ clientIdentity: 'http-runtime-owner' });
      const workspace = await app.arcp.createWorkspace({ ownerActorId: first.actor.id, purpose: 'http runtime auth' });
      const foreign = await app.arcp.registerActor({ clientIdentity: 'http-runtime-foreign' });
      const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      const headers = { 'x-arcp-member-key': workspace.credential, 'content-type': 'application/json' };
      const forgedActor = await fetch(`${base}/v1/runtime-sessions`, { method: 'POST', headers, body: JSON.stringify({ actorId: foreign.actor.id, goalId: 'foreign-goal', profileId: 'codex-worker' }) });
      expect(forgedActor.status).toBe(401);
      const forgedReservation = await fetch(`${base}/v1/runtime-sessions`, { method: 'POST', headers, body: JSON.stringify({ actorId: first.actor.id, goalId: 'missing-goal', profileId: 'codex-worker', replaceReserved: true }) });
      expect(forgedReservation.status).toBe(400);
    } finally {
      app.arcp.close(); await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });
});
