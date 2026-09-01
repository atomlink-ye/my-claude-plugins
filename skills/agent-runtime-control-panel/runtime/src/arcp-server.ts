import type http from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { ArcpError, ArcpService } from './arcp.js';

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> { let text = ''; for await (const part of req) text += String(part); try { return text ? JSON.parse(text) : {}; } catch { throw new ArcpError('invalid_request', 'invalid JSON'); } }
function send(res: http.ServerResponse, status: number, value: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
function publicSession(value: any) { const { workspace: _workspace, externalId: _externalId, ...safe } = value; return safe; }
function publicDelivery(value: any) { const { body: _body, ...safe } = value; return safe; }
function publicActor(value: any) { const { credentialFingerprint: _credentialFingerprint, ...safe } = value; return safe; }
function credentialFingerprint(value: string) { return createHash('sha256').update(value).digest('hex'); }

/** Returns true when an ARCP request was handled. All v1 routes require the local API key. */
export async function handleArcp(req: http.IncomingMessage, res: http.ServerResponse, service: ArcpService): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`); if (!url.pathname.startsWith('/v1/')) return false;
  const configured = process.env.ARCP_API_KEY ?? process.env.PASEO_COMPANION_API_KEY;
  const supplied = req.headers['x-arcp-api-key'] ?? (req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  if (!configured || supplied !== configured) { send(res, 401, { code: 'unauthorized' }); return true; }
  try {
    const method = req.method ?? 'GET'; const path = url.pathname;
    if (method === 'GET' && path === '/v1/profiles') { send(res, 200, service.profiles()); return true; }
    if (method === 'GET' && path === '/v1/discovery') { send(res, 200, await service.discovery()); return true; }
    if (method === 'POST' && path === '/v1/actors') { const result = await service.registerActor({ ...(await body(req) as any), credentialFingerprint: credentialFingerprint(String(configured)) }); send(res, 201, { actor: publicActor(result.actor), binding: result.binding }); return true; }
    if (method === 'GET' && path === '/v1/actors') { send(res, 200, service.state().actors.map(publicActor)); return true; }
    if (method === 'POST' && path === '/v1/actor-bindings') { send(res, 201, await service.bindActor(await body(req) as any)); return true; }
    if (method === 'GET' && path === '/v1/actor-bindings') { send(res, 200, service.state().bindings); return true; }
    if (method === 'POST' && path === '/v1/goals') { send(res, 201, await service.createGoal(await body(req) as any)); return true; }
    if (method === 'GET' && path === '/v1/goals') { send(res, 200, service.state().goals); return true; }
    const goal = path.match(/^\/v1\/goals\/([^/]+)\/lifecycle$/);
    if (method === 'POST' && goal) { send(res, 200, await service.setGoalState(decodeURIComponent(goal[1]), String((await body(req)).state) as any)); return true; }
    if (method === 'POST' && path === '/v1/runtime-sessions') { send(res, 201, publicSession(await service.launch(await body(req) as any))); return true; }
    if (method === 'GET' && path === '/v1/runtime-sessions') { send(res, 200, service.state().sessions.map(publicSession)); return true; }
    const observe = path.match(/^\/v1\/runtime-sessions\/([^/]+)\/(observe|reconcile)$/);
    if (method === 'POST' && observe) { send(res, 200, publicSession(observe[2] === 'observe' ? await service.observe(decodeURIComponent(observe[1])) : await service.reconcile(decodeURIComponent(observe[1])))); return true; }
    if (method === 'POST' && path === '/v1/deliveries') { const requested = await body(req); const actor = service.actorForCredential(credentialFingerprint(String(configured))); send(res, 201, publicDelivery(await service.deliver({ ...requested, fromActorId: actor.id } as any))); return true; }
    if (method === 'GET' && path === '/v1/deliveries') { send(res, 200, service.state().deliveries.map(publicDelivery)); return true; }
    const ack = path.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
    if (method === 'POST' && ack) { const value = await body(req); send(res, 200, publicDelivery(await service.acknowledge(decodeURIComponent(ack[1]), String(value.reason ?? 'processed')))); return true; }
    send(res, 404, { code: 'not_found' }); return true;
  } catch (error) { const code = error instanceof ArcpError ? error.code : 'internal_error'; const status = code === 'not_found' ? 404 : ['unknown_recipient', 'unknown_sender', 'profile_unavailable', 'goal_held'].includes(code) ? 409 : code === 'invalid_request' ? 400 : 500; send(res, status, { code }); return true; }
}
