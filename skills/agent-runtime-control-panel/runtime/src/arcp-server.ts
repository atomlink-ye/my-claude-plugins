import type http from 'node:http';
import { URL } from 'node:url';
import { ArcpError, ArcpService } from './arcp.js';

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> { let text = ''; for await (const part of req) text += String(part); try { return text ? JSON.parse(text) : {}; } catch { throw new ArcpError('invalid_request', 'invalid JSON'); } }
function send(res: http.ServerResponse, status: number, value: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
function publicSession(value: any) { const { workspace: _workspace, externalId: _externalId, ...safe } = value; return safe; }
function publicDelivery(value: any) { const { body: _body, ...safe } = value; return safe; }
function publicActor(value: any) { const { credentialFingerprint: _credentialFingerprint, ...safe } = value; return safe; }
function publicMember(value: any) { const { credentialHash: _credentialHash, ...safe } = value; return safe; }
function publicContext(value: any) { return { ...value, roster: value.roster.map(publicMember), inbox: (value.inbox ?? []).map(publicDelivery) }; }
function publicPanorama(value: any) {
  return { workspace: value.workspace, roster: value.roster.map(publicMember), tasks: value.tasks, goals: value.goals,
    runtime: value.runtime.map((item: any) => ({ session: publicSession(item.session), observation: item.observation, children: item.children, workSummary: item.workSummary })),
    latestKnowledgeRef: value.latestKnowledgeRef, latestResultRef: value.latestResultRef, legacy: value.legacy };
}

/** Returns true when an ARCP request was handled. All v1 routes require the local API key. */
export async function handleArcp(req: http.IncomingMessage, res: http.ServerResponse, service: ArcpService): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`); if (!url.pathname.startsWith('/v1/')) return false;
  const configured = process.env.ARCP_API_KEY ?? process.env.PASEO_COMPANION_API_KEY;
  const supplied = String(req.headers['x-arcp-api-key'] ?? '');
  const actorKey = String(req.headers['x-arcp-actor-key'] ?? '');
  const memberKey = String(req.headers['x-arcp-member-key'] ?? '');
  const admin = Boolean(configured && supplied === configured);
  let authenticatedActor;
  let authenticatedMember;
  try { if (actorKey) authenticatedActor = service.actorForCredential(actorKey); } catch { /* reported below */ }
  try { if (memberKey) authenticatedMember = service.memberForCredential(memberKey); } catch { /* reported below */ }
  if (!admin && !authenticatedActor && !authenticatedMember) { send(res, 401, { code: 'unauthorized' }); return true; }
  try {
    const method = req.method ?? 'GET'; const path = url.pathname;
    if (method === 'GET' && path === '/v1/profiles') { send(res, 200, service.profiles()); return true; }
    if (method === 'GET' && path === '/v1/discovery') { send(res, 200, await service.discovery()); return true; }
    if (method === 'GET' && path === '/v1/doctor') { const discovery = await service.discovery(); send(res, 200, { daemon: 'reachable', provider: discovery.available ? 'available' : 'unavailable', profiles: discovery.profiles.map(({ id, available }) => ({ id, available })), legacy: service.legacySummary() }); return true; }
    if (method === 'POST' && path === '/v1/preflight') { send(res, 200, await service.preflight(await body(req) as any)); return true; }
    if (method === 'POST' && path === '/v1/actors') { if (!admin) throw new ArcpError('unauthorized', 'admin key is required'); const result = await service.registerActor(await body(req) as any); send(res, 201, { actor: publicActor(result.actor), binding: result.binding, ...(result.credential ? { credential: result.credential } : {}) }); return true; }
    if (method === 'GET' && path === '/v1/actors') { send(res, 200, service.state().actors.map(publicActor)); return true; }
    if (method === 'POST' && path === '/v1/workspaces') { const input = await body(req); const ownerActorId = authenticatedActor?.id ?? String(input.ownerActorId ?? ''); send(res, 201, await service.createWorkspace({ ...input, ownerActorId } as any)); return true; }
    if (method === 'POST' && path === '/v1/start') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); const started = await service.startManaged({ ...input, actorId: authenticatedActor.id } as any); if ('action' in started) send(res, 200, started); else send(res, 201, { goal: started.goal, task: started.task, member: publicMember(started.member), session: publicSession(started.session) }); return true; }
    const workspaceContext = path.match(/^\/v1\/workspaces\/([^/]+)\/context$/);
    if (method === 'GET' && workspaceContext) { const workspaceId = decodeURIComponent(workspaceContext[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, publicContext(service.context(workspaceId, authenticatedMember?.id))); return true; }
    const panorama = path.match(/^\/v1\/workspaces\/([^/]+)\/panorama$/);
    if (method === 'GET' && panorama) { const workspaceId = decodeURIComponent(panorama[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, publicPanorama(await service.panorama(workspaceId, url.searchParams.get('refresh') === '1'))); return true; }
    const workspaceJoin = path.match(/^\/v1\/workspaces\/([^/]+)\/join$/);
    if (method === 'POST' && workspaceJoin) { const workspaceId = decodeURIComponent(workspaceJoin[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const result = await service.joinWorkspace({ ...(await body(req) as any), workspaceId, actorId: authenticatedActor?.id, ...(actorKey ? {} : memberKey ? { credential: memberKey } : {}) }); send(res, 201, result); return true; }
    const workspaceTasks = path.match(/^\/v1\/workspaces\/([^/]+)\/tasks$/);
    if (method === 'POST' && workspaceTasks) { send(res, 201, await service.createTask({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceTasks[1]) } as any)); return true; }
    const taskClaim = path.match(/^\/v1\/tasks\/([^/]+)\/claim$/);
    if (method === 'POST' && taskClaim) { const memberKey = String(req.headers['x-arcp-member-key'] ?? ''); const member = service.memberForCredential(memberKey); const input = await body(req); send(res, 200, await service.claimTask(decodeURIComponent(taskClaim[1]), member.id, typeof input.expectedFence === 'number' ? input.expectedFence : undefined)); return true; }
    const workspaceKnowledge = path.match(/^\/v1\/workspaces\/([^/]+)\/knowledge$/);
    if (method === 'POST' && workspaceKnowledge) { const member = service.memberForCredential(String(req.headers['x-arcp-member-key'] ?? '')); send(res, 201, await service.addKnowledge({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceKnowledge[1]), authorMemberId: member.id } as any)); return true; }
    if (method === 'GET' && workspaceKnowledge) { const member = authenticatedMember; const workspaceId = decodeURIComponent(workspaceKnowledge[1]); if (!member || member.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const q = url.searchParams.get('q')?.toLowerCase() ?? ''; const kind = url.searchParams.get('kind') ?? ''; const tag = url.searchParams.get('tag') ?? ''; const entries = service.state().knowledge.filter((item) => item.workspaceId === workspaceId && (!q || item.text.toLowerCase().includes(q)) && (!kind || item.kind === kind) && (!tag || item.tags.includes(tag))); send(res, 200, entries); return true; }
    const workspaceResults = path.match(/^\/v1\/workspaces\/([^/]+)\/results$/);
    if (method === 'POST' && workspaceResults) { const member = service.memberForCredential(String(req.headers['x-arcp-member-key'] ?? '')); send(res, 201, await service.submitResult({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceResults[1]), memberId: member.id } as any)); return true; }
    const heartbeat = path.match(/^\/v1\/members\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeat) { if (!authenticatedMember || authenticatedMember.id !== decodeURIComponent(heartbeat[1])) throw new ArcpError('not_found', 'member not found'); const input = await body(req); send(res, 200, await service.heartbeat(authenticatedMember.id, input.presence as any)); return true; }
    if (method === 'POST' && path === '/v1/actor-bindings') { send(res, 201, await service.bindActor(await body(req) as any)); return true; }
    if (method === 'GET' && path === '/v1/actor-bindings') { send(res, 200, service.state().bindings); return true; }
    if (method === 'POST' && path === '/v1/goals') { const input = await body(req); const actorId = authenticatedActor?.id ?? String(input.actorId ?? ''); send(res, 201, await service.createGoal({ ...input, actorId } as any)); return true; }
    if (method === 'GET' && path === '/v1/goals') { send(res, 200, service.state().goals); return true; }
    const goal = path.match(/^\/v1\/goals\/([^/]+)\/lifecycle$/);
    if (method === 'POST' && goal) { send(res, 200, await service.setGoalState(decodeURIComponent(goal[1]), String((await body(req)).state) as any)); return true; }
    if (method === 'POST' && path === '/v1/runtime-sessions') { const input = await body(req); const actorId = authenticatedActor?.id ?? String(input.actorId ?? ''); send(res, 201, publicSession(await service.launch({ ...input, actorId } as any))); return true; }
    if (method === 'GET' && path === '/v1/runtime-sessions') { send(res, 200, service.state().sessions.map(publicSession)); return true; }
    const observe = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/(observe|reconcile)$/);
    if (method === 'POST' && observe) { send(res, 200, publicSession(observe[2] === 'observe' ? await service.observe(decodeURIComponent(observe[1])) : await service.reconcile(decodeURIComponent(observe[1])))); return true; }
    const runtimeStatus = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/status$/);
    if (method === 'GET' && runtimeStatus) { const value = await service.runtimeStatus(decodeURIComponent(runtimeStatus[1]), url.searchParams.get('refresh') === '1'); send(res, 200, { session: publicSession(value.session), observation: value.observation, children: value.children, workSummary: value.workSummary }); return true; }
    if (method === 'POST' && path === '/v1/deliveries') { const requested = await body(req); if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); send(res, 201, publicDelivery(await service.deliver({ ...requested, fromActorId: authenticatedActor.id } as any))); return true; }
    if (method === 'GET' && path === '/v1/deliveries') { send(res, 200, service.state().deliveries.map(publicDelivery)); return true; }
    const ack = path.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
    if (method === 'POST' && ack) { const value = await body(req); send(res, 200, publicDelivery(await service.acknowledge(decodeURIComponent(ack[1]), String(value.reason ?? 'processed'), typeof value.generation === 'number' ? value.generation : undefined))); return true; }
    send(res, 404, { code: 'not_found' }); return true;
  } catch (error) { const code = error instanceof ArcpError ? error.code : 'internal_error'; const status = code === 'not_found' ? 404 : code === 'unauthorized' ? 401 : ['unknown_recipient', 'unknown_sender', 'profile_unavailable', 'goal_held', 'launch_held', 'stale_generation', 'task_held', 'safe_point_lost', 'workspace_closed'].includes(code) ? 409 : code === 'invalid_request' ? 400 : 500; send(res, status, { code }); return true; }
}
