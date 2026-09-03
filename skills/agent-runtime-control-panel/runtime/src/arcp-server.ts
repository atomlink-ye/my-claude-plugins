import type http from 'node:http';
import { URL } from 'node:url';
import { ArcpError, ArcpService } from './arcp.js';
import type { DecisionVerdict, Member } from './arcp.js';
import { StewardError } from './steward.js';
import type { WorkspaceSteward } from './steward.js';

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> { let text = ''; for await (const part of req) text += String(part); try { return text ? JSON.parse(text) : {}; } catch { throw new ArcpError('invalid_request', 'invalid JSON'); } }
function send(res: http.ServerResponse, status: number, value: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
const providerHandle = /^(externalId|parentAgentId|agentId|nativeId|recipientRef)$/i;
function redactProviderValue(value: any): any {
  if (Array.isArray(value)) return value.map(redactProviderValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => providerHandle.test(key) ? [] : [[key, redactProviderValue(item)]]));
  return typeof value === 'string' && /\/(Users|home|private|tmp)\//.test(value) ? '<redacted>' : value;
}
export function publicSession(value: any) {
  // Session transport/provider receipts are internal provenance. Project the
  // public contract explicitly so newly added nested receipt fields are not
  // exposed by default.
  const keys = ['id', 'actorId', 'goalId', 'taskId', 'reportingRoute', 'executionSurfaceId', 'bindingId', 'generation', 'runtimeKind', 'adapterId', 'workspaceId', 'memberId', 'profileId', 'provider', 'model', 'mode', 'thinking', 'selectionReceipt', 'contractBoundAtLaunch', 'contractRef', 'state', 'lastObservedAt', 'lastDeliveryId', 'lastTurnState', 'blockedOnEventId', 'blockedSince', 'createdAt'];
  const safe = Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  if (value.observed) safe.observed = Object.fromEntries(['provider', 'model', 'mode', 'thinking'].filter((key) => value.observed[key] !== undefined).map((key) => [key, value.observed[key]]));
  if (value.placement) safe.placement = { requested: Object.fromEntries(['projectId', 'workspaceId'].filter((key) => value.placement.requested?.[key] !== undefined).map((key) => [key, value.placement.requested[key]])), ...(value.placement.status ? { status: value.placement.status } : {}) };
  return redactProviderValue(safe);
}
/**
 * children[].id is a raw provider agent id and sits beside session in the
 * response, so publicSession never sees it and the field-name redactor cannot
 * recognise a bare `id`. Name each child by the ARCP RuntimeSession that owns
 * it when ARCP knows one, and drop the handle otherwise: the count and status
 * stay honest without publishing a provider handle.
 */
export function publicChildren(service: ArcpService, value: any) {
  if (!value || !Array.isArray(value.items)) return { source: value?.source ?? 'unavailable', items: [] };
  const sessions = service.state().sessions;
  return { source: value.source, items: value.items.map((child: any) => {
    const owner = sessions.find((item) => item.externalId && item.externalId === child.id);
    const { id: _id, ...rest } = child;
    return { ...(owner ? { runtimeSessionId: owner.id } : {}), ...rest };
  }) };
}
function publicDelivery(value: any) { const { body: _body, ...safe } = value; return safe; }
function publicActor(value: any) { const { credentialFingerprint: _credentialFingerprint, ...safe } = value; return safe; }
function publicMember(value: any) { const { credentialHash: _credentialHash, ...safe } = value; return safe; }
function publicContext(value: any) { return { ...value, roster: value.roster.map(publicMember), inbox: (value.inbox ?? []).map(publicDelivery) }; }
export function publicPanorama(value: any, service: ArcpService) {
  return redactProviderValue({ workspace: value.workspace, roster: value.roster.map(publicMember), tasks: value.tasks, goals: value.goals,
    runtime: value.runtime.map((item: any) => ({ session: publicSession(item.session), observation: item.observation, children: publicChildren(service, item.children), workSummary: item.workSummary })),
    placement: value.placement ?? [],
    cooperation: value.cooperation, execution: value.execution,
    blocked: value.blocked ?? [], temporal: value.temporal,
    events: value.events ?? [], providerBudget: value.providerBudget ?? { status: 'source_unavailable' }, latestKnowledgeRef: value.latestKnowledgeRef, latestResultRef: value.latestResultRef });
}
function publicStartInput(input: Record<string, unknown>) { const keys = ['workspaceId', 'title', 'contract', 'contractDocumentRef', 'role', 'profileId', 'provider', 'model', 'mode', 'thinking', 'unattended', 'paseoProjectId', 'paseoWorkspaceId', 'workspace', 'taskScope', 'executionSurfaceId', 'primaryHandlerMemberId', 'ccMemberIds', 'escalationMemberIds']; return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])); }
function publicRuntimeLaunchInput(input: Record<string, unknown>) { const keys = ['goalId', 'workspaceId', 'profileId', 'provider', 'model', 'mode', 'thinking', 'unattended', 'paseoProjectId', 'paseoWorkspaceId', 'workspace', 'taskId', 'executionSurfaceId']; return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])); }
/**
 * Actor-only launches are the root bootstrap: the very first runtime in a
 * workspace has no member to be launched by. That is the only case they cover,
 * so they are narrowed to the actor that owns the target workspace instead of
 * skipping every relationship check. A launch whose workspace cannot be
 * resolved is unverifiable and fails closed.
 */
function assertRootLaunchAuthority(service: ArcpService, actorId: string, workspaceId?: unknown, goalId?: unknown): void {
  const state = service.state();
  const goal = goalId ? state.goals.find((item) => item.id === goalId) : undefined;
  if (goalId && (!goal || goal.actorId !== actorId)) throw new ArcpError('unauthorized', 'a root launch may only use a goal owned by the authenticated actor');
  const scope = (typeof workspaceId === 'string' && workspaceId) || goal?.workspaceId;
  if (!scope) throw new ArcpError('unauthorized', 'a root launch must name the workspace it is rooted in');
  const workspace = state.workspaces.find((item) => item.id === scope);
  if (!workspace || workspace.ownerActorId !== actorId) throw new ArcpError('unauthorized', 'a root launch requires the workspace owner actor; supply a member credential to launch as a member');
  if (goal?.workspaceId && goal.workspaceId !== scope) throw new ArcpError('unauthorized', 'a root launch goal is not in the requested workspace');
}
function assertLaunchRelationship(service: ArcpService, actorId: string, member: Member | undefined, workspaceId?: unknown, goalId?: unknown, taskId?: unknown) { if (!member) { assertRootLaunchAuthority(service, actorId, workspaceId, goalId); return; } if (member.actorId !== actorId) throw new ArcpError('unauthorized', 'launch member does not belong to authenticated actor'); if (workspaceId && member.workspaceId !== workspaceId) throw new ArcpError('unauthorized', 'launch member is not in requested workspace'); const state = service.state(); if (goalId) { const goal = state.goals.find((item) => item.id === goalId); if (!goal || goal.actorId !== actorId || (goal.workspaceId && goal.workspaceId !== member.workspaceId)) throw new ArcpError('unauthorized', 'launch goal is not authorized for authenticated member'); } if (taskId) { const task = state.tasks.find((item) => item.id === taskId); if (!task || task.workspaceId !== member.workspaceId) throw new ArcpError('unauthorized', 'launch task is not authorized for authenticated member'); } }

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
    if (method === 'GET' && path === '/v1/discovery') { send(res, 200, { ...(await service.discovery()), actorChannels: service.channelDiscovery() }); return true; }
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
    if (method === 'POST' && path === '/v1/external') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); if (!authenticatedMember) throw new ArcpError('unauthorized', 'a member credential is required so the launch has a real parent; an actor-only start would silently create an unparented child'); const input = await body(req); const registered = await service.registerExternal({ ...input, actorId: authenticatedActor.id } as any); send(res, 201, { member: publicMember(registered.member), session: publicSession(registered.session), ...(registered.credential ? { credential: registered.credential } : {}) }); return true; }
    if (method === 'POST' && path === '/v1/undeliverable-dispositions') { if (!authenticatedMember && !admin) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); if (!authenticatedMember) throw new ArcpError('unauthorized', 'disposing an obligation requires the disposing member credential'); const memberId = authenticatedMember.id; const event = await service.disposeUndeliverable({ eventId: String(input.eventId ?? ''), memberId, reason: String(input.reason ?? '') }); send(res, 200, { event: event.id, consumptionState: event.consumptionState, deliveryState: event.deliveryState }); return true; }
    if (method === 'POST' && path === '/v1/escalations') { if (!authenticatedMember && !admin) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); const eventId = String(input.eventId ?? ''); if (!eventId) throw new ArcpError('invalid_request', 'eventId is required', 'eventId'); const reason = String(input.reason ?? '').trim(); if (!reason) throw new ArcpError('invalid_request', 'reason is required', 'reason'); const subject = service.state().channelEvents.find((item) => item.id === eventId); if (!subject) throw new ArcpError('not_found', 'event not found'); if (authenticatedMember && subject.workspaceId !== authenticatedMember.workspaceId) throw new ArcpError('unauthorized', 'member cannot escalate an obligation in another workspace'); const escalated = await service.escalateToOwnerActor({ eventId, reason }); send(res, 200, { event: escalated.event.id, alreadyEscalated: escalated.alreadyEscalated, receipt: escalated.receipt ?? null, deliveryState: service.state().channelEvents.find((item) => item.id === escalated.event.id)?.deliveryState ?? null }); return true; }
    if (method === 'POST' && path === '/v1/participants/attach') { if (!authenticatedMember && !admin) throw new ArcpError('unauthorized', 'member credential is required'); const input = await body(req); const memberId = authenticatedMember ? authenticatedMember.id : String(input.memberId ?? ''); const workspaceId = authenticatedMember ? authenticatedMember.workspaceId : String(input.workspaceId ?? ''); send(res, 201, publicSession(await service.attachParticipant({ workspaceId, memberId, adapterId: String(input.adapterId ?? ''), externalId: String(input.externalId ?? ''), ...(input.workspace ? { workspace: String(input.workspace) } : {}) }))); return true; }
    // Documents carry authority; messages carry deltas and pointers. Writing
    // one requires a member credential, and the author is the credential's
    // member, never a name supplied in the body.
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/documents$/.test(path)) {
      if (!authenticatedMember) throw new ArcpError('unauthorized', 'a member credential is required to author a document');
      const workspaceId = decodeURIComponent(path.split('/')[3]);
      if (authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('unauthorized', 'member cannot author a document in another workspace');
      const input = await body(req);
      send(res, 201, await service.createDocument({ workspaceId, memberId: authenticatedMember.id, kind: String(input.kind ?? 'note'), title: String(input.title ?? ''), body: String(input.body ?? '') }));
      return true;
    }
    if (method === 'GET' && /^\/v1\/workspaces\/[^/]+\/documents$/.test(path)) {
      const workspaceId = decodeURIComponent(path.split('/')[3]);
      if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('unauthorized', 'member cannot list documents in another workspace');
      send(res, 200, service.listDocuments(workspaceId, url.searchParams.get('kind') ?? undefined));
      return true;
    }
    if (method === 'POST' && /^\/v1\/documents\/[^/]+\/revisions$/.test(path)) {
      if (!authenticatedMember) throw new ArcpError('unauthorized', 'a member credential is required to revise a document');
      const documentId = decodeURIComponent(path.split('/')[3]);
      const input = await body(req);
      send(res, 201, await service.reviseDocument({ documentId, memberId: authenticatedMember.id, body: String(input.body ?? '') }));
      return true;
    }
    if (method === 'GET' && /^\/v1\/documents\/[^/]+\/diff$/.test(path)) {
      const documentId = decodeURIComponent(path.split('/')[3]);
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) throw new ArcpError('invalid_request', 'diff requires integer from and to revisions', 'from');
      const document = service.showDocument(documentId).document;
      if (authenticatedMember && authenticatedMember.workspaceId !== document.workspaceId) throw new ArcpError('unauthorized', 'member cannot read a document in another workspace');
      send(res, 200, service.diffDocument(documentId, from, to));
      return true;
    }
    if (method === 'GET' && /^\/v1\/documents\/[^/]+$/.test(path)) {
      const documentId = decodeURIComponent(path.split('/')[3]);
      const revision = url.searchParams.get('revision');
      const shown = service.showDocument(documentId, revision === null ? undefined : Number(revision));
      if (authenticatedMember && authenticatedMember.workspaceId !== shown.document.workspaceId) throw new ArcpError('unauthorized', 'member cannot read a document in another workspace');
      send(res, 200, shown);
      return true;
    }
    if (method === 'POST' && path === '/v1/start') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); const safeInput = publicStartInput(input); assertLaunchRelationship(service, authenticatedActor.id, authenticatedMember, safeInput.workspaceId); const started = await service.startManaged({ ...safeInput, actorId: authenticatedActor.id, ...(authenticatedMember ? { launchedByMemberId: authenticatedMember.id } : {}) } as any); if ('action' in started) send(res, 200, started); else send(res, 201, { goal: started.goal, task: started.task, member: publicMember(started.member), session: publicSession(started.session), credential: started.credential }); return true; }
    const workspaceContext = path.match(/^\/v1\/workspaces\/([^/]+)\/context$/);
    if (method === 'GET' && workspaceContext) { const workspaceId = decodeURIComponent(workspaceContext[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); send(res, 200, publicContext(service.context(workspaceId, authenticatedMember?.id))); return true; }
    const panorama = path.match(/^\/v1\/workspaces\/([^/]+)\/panorama$/);
    if (method === 'GET' && panorama) { const workspaceId = decodeURIComponent(panorama[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const temporal = url.searchParams.get('temporal'); const filter = temporal === 'problems' ? 'problems' : temporal === 'task' && url.searchParams.get('task') ? { taskId: String(url.searchParams.get('task')) } : 'active'; send(res, 200, publicPanorama(await service.panorama(workspaceId, url.searchParams.get('refresh') === '1', filter), service)); return true; }
    const archiveSurface = path.match(/^\/v1\/workspaces\/([^/]+)\/execution-surfaces\/([^/]+)\/archive$/);
    if (method === 'POST' && archiveSurface) { if (!authenticatedActor) throw new ArcpError('unauthorized', 'owner actor credential is required'); const workspaceId = decodeURIComponent(archiveSurface[1]); await service.archiveSurface({ id: decodeURIComponent(archiveSurface[2]) }, { controlWorkspaceId: workspaceId, actorId: authenticatedActor.id }); send(res, 200, { archived: true, surfaceId: decodeURIComponent(archiveSurface[2]) }); return true; }
    const restoreSurface = path.match(/^\/v1\/workspaces\/([^/]+)\/execution-surfaces\/([^/]+)\/restore$/);
    if (method === 'POST' && restoreSurface) { if (!authenticatedActor) throw new ArcpError('unauthorized', 'owner actor credential is required'); const workspaceId = decodeURIComponent(restoreSurface[1]); const restored = await service.restoreSurface({ id: decodeURIComponent(restoreSurface[2]) }, { controlWorkspaceId: workspaceId, actorId: authenticatedActor.id }); send(res, 200, restored); return true; }
    const channelReconcile = path.match(/^\/v1\/workspaces\/([^/]+)\/channel\/reconcile$/);
    if (channelReconcile) { const workspaceId = decodeURIComponent(channelReconcile[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); if (method !== 'GET' || url.searchParams.get('dry-run') !== '1') throw new ArcpError('invalid_request', 'channel reconcile requires --dry-run in Round 4; applying dispositions is refused'); send(res, 200, { dryRun: true, proposals: service.temporalReconciliation(workspaceId) }); return true; }
    const runtimeDecision = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/decision$/);
    if (method === 'POST' && runtimeDecision) { const input = await body(req); send(res, 201, await service.raiseDecision({ runtimeSessionId: decodeURIComponent(runtimeDecision[1]), question: String(input.question ?? ''), ...(Array.isArray(input.options) ? { options: input.options.map(String) } : {}) }).then((raised) => ({ event: raised.event, session: publicSession(raised.session) }))); return true; }
    const workspaceJoin = path.match(/^\/v1\/workspaces\/([^/]+)\/join$/);
    if (method === 'POST' && workspaceJoin) { const workspaceId = decodeURIComponent(workspaceJoin[1]); if (authenticatedMember && authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found'); const result = await service.joinWorkspace({ ...(await body(req) as any), workspaceId, actorId: authenticatedActor?.id, ...(actorKey ? {} : memberKey ? { credential: memberKey } : {}) }); send(res, 201, result); return true; }
    const workspaceTasks = path.match(/^\/v1\/workspaces\/([^/]+)\/tasks$/);
    if (method === 'POST' && workspaceTasks) {
      const workspaceId = decodeURIComponent(workspaceTasks[1]);
      if (authenticatedMember && !admin) {
        if (authenticatedMember.workspaceId !== workspaceId) throw new ArcpError('not_found', 'workspace not found');
        if (authenticatedMember.role === 'steward' || authenticatedMember.role === 'steward-analyst') throw new ArcpError('unauthorized', 'Steward credentials cannot create product Tasks');
      }
      send(res, 201, await service.createTask({ ...(await body(req) as any), workspaceId } as any)); return true;
    }
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
    if (method === 'POST' && path === '/v1/runtime-sessions') {
      const input = await body(req);
      // A member credential authenticates a member, not an arbitrary actor id
      // supplied in JSON. Require the actor principal to be explicit and bind
      // it to the member before permitting a launch/replacement attempt.
      if (authenticatedMember && !authenticatedActor && (!authenticatedMember.actorId || (input.actorId !== undefined && input.actorId !== authenticatedMember.actorId))) throw new ArcpError('unauthorized', 'member-authenticated runtime launch requires its bound actor principal');
      if (authenticatedActor && authenticatedMember?.actorId && authenticatedMember.actorId !== authenticatedActor.id) throw new ArcpError('unauthorized', 'actor and member credentials identify different principals');
      if ('replaceReserved' in input) throw new ArcpError('invalid_request', 'runtime replacement reservation is internal-only', 'replaceReserved');
      // The actor principal comes from a credential, never from the body.
      const actorId = authenticatedActor?.id ?? authenticatedMember?.actorId;
      if (!actorId) throw new ArcpError('unknown_sender', 'actor credential is required');
      const safeInput = publicRuntimeLaunchInput(input);
      assertLaunchRelationship(service, actorId, authenticatedMember, safeInput.workspaceId, safeInput.goalId, safeInput.taskId);
      send(res, 201, publicSession(await service.launch({ ...safeInput, actorId, ...(authenticatedMember ? { launchedByMemberId: authenticatedMember.id } : {}) } as any))); return true;
    }
    if (method === 'GET' && path === '/v1/runtime-sessions') { const sessions = service.state().sessions.filter((item) => !authenticatedMember || item.workspaceId === authenticatedMember.workspaceId); send(res, 200, sessions.map(publicSession)); return true; }
    const external = path.match(/^\/v1\/external\/([^/]+)\/(status|send|stop|reconcile)$/);
    if (external && authenticatedMember) { const target = service.state().sessions.find((item) => item.id === decodeURIComponent(external[1])); if (!target || target.workspaceId !== authenticatedMember.workspaceId) throw new ArcpError('not_found', 'runtime session not found'); }
    if (external && authenticatedActor && ['stop', 'reconcile'].includes(external[2])) { const state = service.state(); const target = state.sessions.find((item) => item.id === decodeURIComponent(external[1])); if (!target || !state.members.some((member) => member.actorId === authenticatedActor!.id && member.workspaceId === target.workspaceId)) throw new ArcpError('not_found', 'runtime session not found'); }
    if (external && method === 'GET' && external[2] === 'status') { const value = await service.runtimeStatus(decodeURIComponent(external[1]), url.searchParams.get('refresh') === '1'); send(res, 200, { session: publicSession(value.session), observation: value.observation, children: publicChildren(service, value.children), workSummary: value.workSummary }); return true; }
    if (external && method === 'POST' && external[2] === 'send') { if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const input = await body(req); send(res, 200, publicDelivery(await service.deliver({ ...input, runtimeSessionId: decodeURIComponent(external[1]), fromActorId: authenticatedActor.id } as any))); return true; }
    if (external && method === 'POST' && external[2] === 'stop') { send(res, 200, publicSession(await service.stopRuntime(decodeURIComponent(external[1])))); return true; }
    if (external && method === 'POST' && external[2] === 'reconcile') { send(res, 200, publicSession(await service.reconcile(decodeURIComponent(external[1])))); return true; }
    const observe = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/(observe|reconcile)$/);
    if (method === 'POST' && observe) { send(res, 200, publicSession(observe[2] === 'observe' ? await service.observe(decodeURIComponent(observe[1])) : await service.reconcile(decodeURIComponent(observe[1])))); return true; }
    const runtimeStatus = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/status$/);
    if (method === 'GET' && runtimeStatus) { const value = await service.runtimeStatus(decodeURIComponent(runtimeStatus[1]), url.searchParams.get('refresh') === '1'); send(res, 200, { session: publicSession(value.session), observation: value.observation, children: publicChildren(service, value.children), workSummary: value.workSummary }); return true; }
    if (method === 'POST' && path === '/v1/deliveries') { const requested = await body(req); if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); const { fromActorId: _untrustedActor, ...publicRequested } = requested; send(res, 201, publicDelivery(await service.deliver({ ...publicRequested, fromActorId: authenticatedActor.id } as any))); return true; }
    if (method === 'POST' && path === '/v1/reuse') { const requested = await body(req); if (!authenticatedActor) throw new ArcpError('unknown_sender', 'actor credential is required'); send(res, 200, publicDelivery(await service.reuse({ ...requested, fromActorId: authenticatedActor.id } as any))); return true; }
    if (method === 'GET' && path === '/v1/deliveries') { send(res, 200, service.state().deliveries.map(publicDelivery)); return true; }
    const process = path.match(/^\/v1\/deliveries\/([^/]+)\/process$/);
    if (method === 'POST' && process) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.processDelivery(decodeURIComponent(process[1]), authenticatedMember.id, typeof value.reason === 'string' ? value.reason : undefined))); return true; }
    const ack = path.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
    if (method === 'POST' && ack) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.acknowledge(decodeURIComponent(ack[1]), typeof value.generation === 'number' ? value.generation : undefined, authenticatedMember.id))); return true; }
    const withdraw = path.match(/^\/v1\/deliveries\/([^/]+)\/withdraw$/);
    if (method === 'POST' && withdraw) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.withdraw(decodeURIComponent(withdraw[1]), String(value.reason ?? 'withdrawn'), authenticatedMember.id))); return true; }
    const release = path.match(/^\/v1\/deliveries\/([^/]+)\/release$/);
    if (method === 'POST' && release) { if (!authenticatedMember) throw new ArcpError('unauthorized', 'member credential is required'); const value = await body(req); send(res, 200, publicDelivery(await service.release(decodeURIComponent(release[1]), authenticatedMember.id, typeof value.confirmation === 'string' ? value.confirmation : undefined))); return true; }
    send(res, 404, { code: 'not_found', message: 'ARCP route not found' }); return true;
  } catch (error) { const code = error instanceof ArcpError || error instanceof StewardError ? error.code : 'internal_error'; const status = code === 'not_found' ? 404 : code === 'unauthorized' ? 401 : ['unknown_recipient', 'unknown_sender', 'profile_unavailable', 'goal_held', 'launch_held', 'stale_generation', 'task_held', 'safe_point_lost', 'workspace_closed', 'steward_provider_unavailable'].includes(code) ? 409 : code === 'invalid_request' ? 400 : 500; const message = error instanceof ArcpError || error instanceof StewardError ? error.message : 'internal error'; send(res, status, { code, message, ...(error instanceof ArcpError && error.field ? { field: error.field } : {}) }); return true; }
}
