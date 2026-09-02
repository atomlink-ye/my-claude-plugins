import type http from 'node:http';
import { URL } from 'node:url';
import { ArcpError, ArcpService } from './arcp.js';
import type { DecisionVerdict, Member } from './arcp.js';
import { StewardError } from './steward.js';
import type { WorkspaceSteward } from './steward.js';

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
    placement: value.placement ?? [],
    cooperation: value.cooperation, execution: value.execution,
    blocked: value.blocked ?? [], temporal: value.temporal,
    events: value.events ?? [], providerBudget: value.providerBudget ?? { status: 'source_unavailable' }, latestKnowledgeRef: value.latestKnowledgeRef, latestResultRef: value.latestResultRef };
}

/**
 * Build the per-Workspace Workspace Steward. Both triggers - Lane A's
 * supervision breach and this file's member-requested route - construct the
 * Steward here, so neither can quietly acquire a different execution path.
 */
export async function stewardFor(service: ArcpService, workspaceId: string): Promise<WorkspaceSteward> {
  return service.workspaceSteward(workspaceId);
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
  let authenticatedMember: Member | undefined;
  try { if (actorKey) authenticatedActor = service.actorForCredential(actorKey); } catch { /* reported below */ }
  try { if (memberKey) authenticatedMember = service.memberForCredential(memberKey); } catch { /* reported below */ }
  if (!admin && !authenticatedActor && !authenticatedMember) { send(res, 401, { code: 'unauthorized', message: 'an ARCP API key, actor credential, or member credential is required' }); return true; }
  try {
    const method = req.method ?? 'GET'; const path = url.pathname;
    if (method === 'GET' && path === '/v1/profiles') { send(res, 200, service.profiles()); return true; }
    if (method === 'GET' && path === '/v1/discovery') { send(res, 200, await service.discovery()); return true; }
    if (method === 'GET' && path === '/v1/doctor') { const discovery = await service.discovery(); send(res, 200, { daemon: 'reachable', provider: discovery.available ? 'available' : 'unavailable', profiles: discovery.profiles.map(({ id, available }) => ({ id, available })), database: service.store.check?.() ?? service.store.snapshot(), }); return true; }
    if (method === 'POST' && path === '/v1/preflight') { send(res, 200, await service.preflight(await body(req) as any)); return true; }
    if (method === 'GET' && path === '/v1/provider-budgets') { send(res, 200, service.providerBudget() ?? { status: 'source_unavailable' }); return true; }
    if (method === 'POST' && path === '/v1/provider-budgets/refresh') { if (!admin && !authenticatedMember) throw new ArcpError('unauthorized', 'operator or member credential is required'); const input = await body(req); send(res, 200, await service.refreshProviderBudget(typeof input.sourceId === 'string' ? input.sourceId : undefined)); return true; }
    if (method === 'POST' && path === '/v1/actors') { if (!admin) throw new ArcpError('unauthorized', 'admin key is required'); const result = await service.registerActor(await body(req) as any); send(res, 201, { actor: publicActor(result.actor), binding: result.binding, ...(result.credential ? { credential: result.credential } : {}) }); return true; }
    if (method === 'GET' && path === '/v1/actors') { send(res, 200, service.state().actors.map(publicActor)); return true; }
    if (method === 'POST' && path === '/v1/workspaces') { const input = await body(req); const ownerActorId = authenticatedActor?.id ?? String(input.ownerActorId ?? ''); const created = await service.createWorkspace({ ...input, ownerActorId } as any); send(res, 201, created); return true; }
    // Actor/admin callers are the discovery plane and may list all workspaces;
    // member callers remain scoped to their own workspace, like context/panorama.
    if (method === 'GET' && path === '/v1/workspaces') { const workspaces = service.state().workspaces; send(res, 200, authenticatedMember ? workspaces.filter((item) => item.id === authenticatedMember!.workspaceId) : workspaces); return true; }
    if (method === 'POST' && path === '/v1/external') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); const registered = await service.registerExternal({ ...input, actorId: authenticatedActor.id } as any); send(res, 201, { member: publicMember(registered.member), session: publicSession(registered.session), ...(registered.credential ? { credential: registered.credential } : {}) }); return true; }
    if (method === 'POST' && path === '/v1/start') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); const started = await service.startManaged({ ...input, actorId: authenticatedActor.id } as any); if ('action' in started) send(res, 200, started); else send(res, 201, { goal: started.goal, task: started.task, member: publicMember(started.member), session: publicSession(started.session), credential: started.credential }); return true; }
    const workspaceContext = path.match(/^\/v1\/workspaces\/([^/]+)\/context$/);
    if (method === 'GET' && workspaceContext) { const workspaceId = decodeURIComponent(workspaceContext[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, publicContext(service.context(workspaceId, authenticatedMember?.id))); return true; }
    const panorama = path.match(/^\/v1\/workspaces\/([^/]+)\/panorama$/);
    if (method === 'GET' && panorama) { const workspaceId = decodeURIComponent(panorama[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const temporal = url.searchParams.get('temporal'); const filter = temporal === 'problems' ? 'problems' : temporal === 'task' && url.searchParams.get('task') ? { taskId: String(url.searchParams.get('task')) } : 'active'; send(res, 200, publicPanorama(await service.panorama(workspaceId, url.searchParams.get('refresh') === '1', filter))); return true; }
    const archiveSurface = path.match(/^\/v1\/workspaces\/([^/]+)\/execution-surfaces\/([^/]+)\/archive$/);
    if (method === 'POST' && archiveSurface) { if (!authenticatedActor) throw new ArcpError('unauthorized', 'owner actor credential is required'); const workspaceId = decodeURIComponent(archiveSurface[1]); await service.archiveSurface({ id: decodeURIComponent(archiveSurface[2]) }, { controlWorkspaceId: workspaceId, actorId: authenticatedActor.id }); send(res, 200, { archived: true, surfaceId: decodeURIComponent(archiveSurface[2]) }); return true; }
    const channelReconcile = path.match(/^\/v1\/workspaces\/([^/]+)\/channel\/reconcile$/);
    if (channelReconcile) { const workspaceId = decodeURIComponent(channelReconcile[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); if (method !== 'GET' || url.searchParams.get('dry-run') !== '1') throw new ArcpError('invalid_request', 'channel reconcile requires --dry-run in Round 4; applying dispositions is refused'); send(res, 200, { dryRun: true, proposals: service.temporalReconciliation(workspaceId) }); return true; }
    const runtimeDecision = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/decision$/);
    if (method === 'POST' && runtimeDecision) { const input = await body(req); send(res, 201, await service.raiseDecision({ runtimeSessionId: decodeURIComponent(runtimeDecision[1]), question: String(input.question ?? ''), ...(Array.isArray(input.options) ? { options: input.options.map(String) } : {}) }).then((raised) => ({ event: raised.event, session: publicSession(raised.session) }))); return true; }
    const workspaceJoin = path.match(/^\/v1\/workspaces\/([^/]+)\/join$/);
    if (method === 'POST' && workspaceJoin) { const workspaceId = decodeURIComponent(workspaceJoin[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const result = await service.joinWorkspace({ ...(await body(req) as any), workspaceId, actorId: authenticatedActor?.id, ...(actorKey ? {} : memberKey ? { credential: memberKey } : {}) }); send(res, 201, result); return true; }
    const workspaceTasks = path.match(/^\/v1\/workspaces\/([^/]+)\/tasks$/);
    if (method === 'POST' && workspaceTasks) { send(res, 201, await service.createTask({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceTasks[1]) } as any)); return true; }
    if (method === 'GET' && workspaceTasks) { const workspaceId = decodeURIComponent(workspaceTasks[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, service.state().tasks.filter((item) => item.workspaceId === workspaceId)); return true; }
    const taskClaim = path.match(/^\/v1\/tasks\/([^/]+)\/claim$/);
    if (method === 'POST' && taskClaim) { const memberKey = String(req.headers['x-arcp-member-key'] ?? ''); const member = service.memberForCredential(memberKey); const input = await body(req); send(res, 200, await service.claimTask(decodeURIComponent(taskClaim[1]), member.id, typeof input.expectedFence === 'number' ? input.expectedFence : undefined)); return true; }
    const workspaceKnowledge = path.match(/^\/v1\/workspaces\/([^/]+)\/knowledge$/);
    if (method === 'POST' && workspaceKnowledge) { const member = service.memberForCredential(String(req.headers['x-arcp-member-key'] ?? '')); send(res, 201, await service.addKnowledge({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceKnowledge[1]), authorMemberId: member.id } as any)); return true; }
    if (method === 'GET' && workspaceKnowledge) { const member = authenticatedMember; const workspaceId = decodeURIComponent(workspaceKnowledge[1]); if (!member || member.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const q = url.searchParams.get('q')?.toLowerCase() ?? ''; const kind = url.searchParams.get('kind') ?? ''; const tag = url.searchParams.get('tag') ?? ''; const entries = service.state().knowledge.filter((item) => item.workspaceId === workspaceId && (!q || item.text.toLowerCase().includes(q)) && (!kind || item.kind === kind) && (!tag || item.tags.includes(tag))); send(res, 200, entries); return true; }
    const workspaceResults = path.match(/^\/v1\/workspaces\/([^/]+)\/results$/);
    if (method === 'POST' && workspaceResults) { const member = service.memberForCredential(String(req.headers['x-arcp-member-key'] ?? '')); send(res, 201, await service.submitResult({ ...(await body(req) as any), workspaceId: decodeURIComponent(workspaceResults[1]), memberId: member.id } as any)); return true; }
    if (method === 'GET' && workspaceResults) { const workspaceId = decodeURIComponent(workspaceResults[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, service.state().results.filter((item) => item.workspaceId === workspaceId)); return true; }
    const workspaceMembers = path.match(/^\/v1\/workspaces\/([^/]+)\/members$/);
    if (method === 'GET' && workspaceMembers) { const workspaceId = decodeURIComponent(workspaceMembers[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, service.state().members.filter((item) => item.workspaceId === workspaceId).map(publicMember)); return true; }
    const stewardAnalyses = path.match(/^\/v1\/workspaces\/([^/]+)\/steward\/analyses$/);
    if (method === 'POST' && stewardAnalyses) {
      const workspaceId = decodeURIComponent(stewardAnalyses[1]);
      if (!authenticatedMember || authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('unauthorized', 'a member credential for this workspace is required');
      const input = await body(req);
      const steward = await stewardFor(service, workspaceId);
      send(res, 200, await steward.requestAnalysis({ workspaceId, subjectTaskId: String(input.taskId ?? ''), requestedByMemberId: authenticatedMember.id }));
      return true;
    }
    const stewardReports = path.match(/^\/v1\/workspaces\/([^/]+)\/steward\/reports$/);
    if (method === 'GET' && stewardReports) {
      const workspaceId = decodeURIComponent(stewardReports[1]);
      if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found');
      send(res, 200, (await stewardFor(service, workspaceId)).reports(workspaceId));
      return true;
    }
    const workspaceSupervision = path.match(/^\/v1\/workspaces\/([^/]+)\/supervision$/);
    if (method === 'POST' && workspaceSupervision) {
      const workspaceId = decodeURIComponent(workspaceSupervision[1]);
      if (!authenticatedMember || authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('unauthorized', 'a member credential for this workspace is required');
      // Same authorization as acknowledging a review: Manager or the Workspace
      // Owner sets the budget that governs the automatic Steward trigger.
      const workspace = service.state().workspaces.find((item) => item.id === workspaceId);
      if (authenticatedMember.role !== 'manager' && workspace?.ownerMemberId !== authenticatedMember.id) throw new ArcpError('unauthorized', 'supervision configuration is not authorized');
      const input = await body(req);
      send(res, 200, await service.configureSupervision({
        workspaceId,
        ...(typeof input.reviewAfterMs === 'number' ? { reviewAfterMs: input.reviewAfterMs } : {}),
        ...(typeof input.inactivityAfterMs === 'number' ? { inactivityAfterMs: input.inactivityAfterMs } : {}),
        ...(typeof input.cooldownMs === 'number' ? { cooldownMs: input.cooldownMs } : {}),
        ...(typeof input.stewardProfileId === 'string' ? { stewardProfileId: input.stewardProfileId } : {}),
        ...(typeof input.automatic === 'boolean' ? { automatic: input.automatic } : {}),
      }));
      return true;
    }
    if (method === 'GET' && workspaceSupervision) {
      const workspaceId = decodeURIComponent(workspaceSupervision[1]);
      if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found');
      send(res, 200, { policy: service.supervisionPolicy(workspaceId) ?? null, reviews: service.supervisionReviews(workspaceId) });
      return true;
    }
    const workspaceEvents = path.match(/^\/v1\/workspaces\/([^/]+)\/events$/);
    if (method === 'GET' && workspaceEvents) {
      const workspaceId = decodeURIComponent(workspaceEvents[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found');
      const kind = url.searchParams.get('kind'); const state = url.searchParams.get('state'); const consumption = url.searchParams.get('consumption'); const policy = url.searchParams.get('policy'); const decisionRequired = url.searchParams.get('decision-required');
      let events = service.channelEvents(workspaceId, authenticatedMember?.id);
      if (kind) events = events.filter((event) => event.kind === kind);
      if (state) events = events.filter((event) => event.deliveryState === state);
      if (consumption) events = events.filter((event) => event.consumptionState === consumption);
      if (policy) events = events.filter((event) => event.consumptionPolicy === policy);
      // Only decision_required events are accepted by resolveDecision. Other
      // urgent facts may carry decisionRequired for attention signalling, but
      // they are not resolvable through this endpoint.
      if (decisionRequired === '1' || decisionRequired === 'true') events = events.filter((event) => event.kind === 'decision_required' && event.decisionRequired);
      if (decisionRequired === '0' || decisionRequired === 'false') events = events.filter((event) => !event.decisionRequired);
      send(res, 200, events); return true;
    }
    const eventResolve = path.match(/^\/v1\/events\/([^/]+)\/resolve$/);
    if (method === 'POST' && eventResolve) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); if (input.verdict !== 'accept' && input.verdict !== 'refuse') throw new ArcpError('invalid_request', 'decision verdict must be accept or refuse', 'verdict'); send(res, 200, await service.resolveDecision(decodeURIComponent(eventResolve[1]), authenticatedMember.id, typeof input.summary === 'string' ? input.summary : '', input.verdict, typeof input.dispositionId === 'string' ? input.dispositionId : undefined)); return true; }
    const eventAck = path.match(/^\/v1\/events\/([^/]+)\/ack$/);
    if (method === 'POST' && eventAck) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); send(res, 200, await service.acknowledgeEvent(decodeURIComponent(eventAck[1]), authenticatedMember.id, typeof input.reason === 'string' ? input.reason : '', typeof input.dispositionId === 'string' ? input.dispositionId : undefined)); return true; }
    const eventDefer = path.match(/^\/v1\/events\/([^/]+)\/defer$/);
    if (method === 'POST' && eventDefer) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); const resume = input.resume as any; if (!resume || typeof resume !== 'object') throw new ArcpError('invalid_request', 'defer resume is required'); send(res, 200, await service.deferEvent(decodeURIComponent(eventDefer[1]), authenticatedMember.id, { kind: 'defer', reason: typeof input.reason === 'string' ? input.reason : '', resume, ...(typeof input.dispositionId === 'string' ? { id: input.dispositionId } : {}) })); return true; }
    const eventResume = path.match(/^\/v1\/events\/([^/]+)\/resume$/);
    if (method === 'POST' && eventResume) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); send(res, 200, await service.resumeEvent(decodeURIComponent(eventResume[1]), authenticatedMember.id, typeof input.dispositionId === 'string' ? input.dispositionId : undefined)); return true; }
    const heartbeat = path.match(/^\/v1\/members\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeat) { if (!authenticatedMember || authenticatedMember.id !== decodeURIComponent(heartbeat[1])) throw new ArcpError('not_found', 'member not found'); const input = await body(req); send(res, 200, await service.heartbeat(authenticatedMember.id, input.presence as any)); return true; }
    if (method === 'POST' && path === '/v1/actor-bindings') { send(res, 201, await service.bindActor(await body(req) as any)); return true; }
    if (method === 'GET' && path === '/v1/actor-bindings') { send(res, 200, service.state().bindings); return true; }
    if (method === 'POST' && path === '/v1/goals') { const input = await body(req); const actorId = authenticatedActor?.id ?? String(input.actorId ?? ''); send(res, 201, await service.createGoal({ ...input, actorId } as any)); return true; }
    if (method === 'GET' && path === '/v1/goals') { const state = service.state(); const sessionIds = new Set(state.sessions.filter((item) => !authenticatedMember || item.workspaceId === authenticatedMember.workspaceId).map((item) => item.goalId)); send(res, 200, authenticatedMember ? state.goals.filter((item) => item.workspaceId === authenticatedMember!.workspaceId || sessionIds.has(item.id)) : state.goals); return true; }
    const goal = path.match(/^\/v1\/goals\/([^/]+)\/lifecycle$/);
    if (method === 'POST' && goal) { send(res, 200, await service.setGoalState(decodeURIComponent(goal[1]), String((await body(req)).state) as any)); return true; }
    if (method === 'POST' && path === '/v1/runtime-sessions') { const input = await body(req); const actorId = authenticatedActor?.id ?? String(input.actorId ?? ''); send(res, 201, publicSession(await service.launch({ ...input, actorId } as any))); return true; }
    if (method === 'GET' && path === '/v1/runtime-sessions') { const sessions = service.state().sessions.filter((item) => !authenticatedMember || item.workspaceId === authenticatedMember.workspaceId); send(res, 200, sessions.map(publicSession)); return true; }
    const external = path.match(/^\/v1\/external\/([^/]+)\/(status|send|stop|reconcile)$/);
    if (external && authenticatedMember) { const target = service.state().sessions.find((item) => item.id === decodeURIComponent(external[1])); if (!target || target.workspaceId !== authenticatedMember.workspaceId) throw new ArcpError('not_found', 'runtime session not found'); }
    if (external && authenticatedActor && ['stop', 'reconcile'].includes(external[2])) { const state = service.state(); const target = state.sessions.find((item) => item.id === decodeURIComponent(external[1])); if (!target || !state.members.some((member) => member.actorId === authenticatedActor!.id && member.workspaceId === target.workspaceId)) throw new ArcpError('not_found', 'runtime session not found'); }
    if (external && method === 'GET' && external[2] === 'status') { const value = await service.runtimeStatus(decodeURIComponent(external[1]), url.searchParams.get('refresh') === '1'); send(res, 200, { session: publicSession(value.session), observation: value.observation, children: value.children, workSummary: value.workSummary }); return true; }
    if (external && method === 'POST' && external[2] === 'send') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); send(res, 200, publicDelivery(await service.deliver({ ...input, runtimeSessionId: decodeURIComponent(external[1]), fromActorId: authenticatedActor.id } as any))); return true; }
    if (external && method === 'POST' && external[2] === 'stop') { send(res, 200, publicSession(await service.stopRuntime(decodeURIComponent(external[1])))); return true; }
    if (external && method === 'POST' && external[2] === 'reconcile') { send(res, 200, publicSession(await service.reconcile(decodeURIComponent(external[1])))); return true; }
    const observe = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/(observe|reconcile)$/);
    if (method === 'POST' && observe) { send(res, 200, publicSession(observe[2] === 'observe' ? await service.observe(decodeURIComponent(observe[1])) : await service.reconcile(decodeURIComponent(observe[1])))); return true; }
    const runtimeStatus = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/status$/);
    if (method === 'GET' && runtimeStatus) { const value = await service.runtimeStatus(decodeURIComponent(runtimeStatus[1]), url.searchParams.get('refresh') === '1'); send(res, 200, { session: publicSession(value.session), observation: value.observation, children: value.children, workSummary: value.workSummary }); return true; }
    if (method === 'POST' && path === '/v1/deliveries') { const requested = await body(req); if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const { fromActorId: _untrustedActor, ...publicRequested } = requested; send(res, 201, publicDelivery(await service.deliver({ ...publicRequested, fromActorId: authenticatedActor.id } as any))); return true; }
    if (method === 'POST' && path === '/v1/reuse') { const requested = await body(req); if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); send(res, 200, publicDelivery(await service.reuse({ ...requested, fromActorId: authenticatedActor.id } as any))); return true; }
    if (method === 'GET' && path === '/v1/deliveries') { send(res, 200, service.state().deliveries.map(publicDelivery)); return true; }
    const ack = path.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
    if (method === 'POST' && ack) { const value = await body(req); send(res, 200, publicDelivery(await service.acknowledge(decodeURIComponent(ack[1]), typeof value.generation === 'number' ? value.generation : undefined))); return true; }
    const withdraw = path.match(/^\/v1\/deliveries\/([^/]+)\/withdraw$/);
    if (method === 'POST' && withdraw) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.withdraw(decodeURIComponent(withdraw[1]), String(value.reason ?? 'withdrawn'), authenticatedMember.id))); return true; }
    const release = path.match(/^\/v1\/deliveries\/([^/]+)\/release$/);
    if (method === 'POST' && release) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.release(decodeURIComponent(release[1]), authenticatedMember.id, typeof value.confirmation === 'string' ? value.confirmation : undefined))); return true; }
    send(res, 404, { code: 'not_found', message: 'ARCP route not found' }); return true;
  } catch (error) { const code = error instanceof ArcpError || error instanceof StewardError ? error.code : 'internal_error'; const status = code === 'not_found' ? 404 : code === 'unauthorized' ? 401 : ['unknown_recipient', 'unknown_sender', 'profile_unavailable', 'goal_held', 'launch_held', 'stale_generation', 'task_held', 'safe_point_lost', 'workspace_closed', 'steward_provider_unavailable'].includes(code) ? 409 : code === 'invalid_request' ? 400 : 500; const message = error instanceof ArcpError || error instanceof StewardError ? error.message : 'internal error'; send(res, status, { code, message, ...(error instanceof ArcpError && error.field ? { field: error.field } : {}) }); return true; }
}
