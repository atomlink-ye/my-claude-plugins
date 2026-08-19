import http from 'node:http';
import { URL } from 'node:url';
import { CompanionService } from './service.js';
import { PaseoScheduleObserver } from './schedule-observer.js';
import { PaseoContextUsageObserver } from './context-usage-observer.js';
import { CompanionError, invalidValue, missingField } from './errors.js';

export interface CompanionServer {
  server: http.Server;
  service: CompanionService;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) data += String(chunk);
  if (!data.trim()) return {};
  try { return JSON.parse(data); } catch { throw new CompanionError('invalid_value', 'invalid JSON'); }
}
function send(res: http.ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) missingField(name);
  return value;
}

const ROUTES = [
  ['GET', '/health', []], ['GET', '/self/runtime', []], ['GET', '/heartbeats', []],
  ['DELETE', '/heartbeats/:id', ['reason']], ['GET', '/wakeup-sources', ['agentId']],
  ['PUT', '/wakeup-sources/:id', ['agentId', 'cadence']], ['DELETE', '/wakeup-sources/:id', ['agentId']],
  ['GET', '/children', ['agentId']], ['PUT', '/children/:childId', ['agentId']],
  ['DELETE', '/children/:childId', ['agentId', 'reason']], ['PUT', '/children/:childId/watch', ['agentId']],
  ['DELETE', '/children/:childId/watch', ['agentId', 'reason']], ['GET', '/children/:id/briefing', []],
  ['POST', '/reminders', ['agentId', 'message']], ['GET', '/reminders', []], ['GET', '/reminders/:id', []], ['DELETE', '/reminders/:id', ['reason']],
  ['POST', '/idle-reminders', ['agentId', 'message', 'thresholdSeconds']], ['GET', '/idle-reminders', []],
  ['DELETE', '/idle-reminders/:id', ['reason']], ['POST', '/messages', ['to', 'from', 'body']],
  ['GET', '/messages', []], ['DELETE', '/messages/:id', ['reason']], ['POST', '/compact-wake', ['agentId', 'compact']],
  ['POST', '/ledger', ['type', 'target', 'verdict', 'reason']], ['GET', '/ledger', []],
  ['POST', '/ledger/:id/revoke', ['reason']],
  ['POST', '/corrections', ['managerId', 'auditorId', 'findings']], ['GET', '/corrections', []],
  ['POST', '/corrections/:id/resolve', ['findingId', 'verdict']], ['GET', '/gate', ['managerId']],
] as const;
const ERROR_STATUS: Record<string, number> = { missing_field: 400, invalid_value: 400, not_found: 404, ambiguous_id: 409, state_corrupt: 503, cli_error: 502 };

export async function createServer(service = new CompanionService(undefined, undefined, new PaseoScheduleObserver(), undefined, { contextUsageObserver: new PaseoContextUsageObserver() })): Promise<CompanionServer> {
  await service.init();
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;
      if (method === 'GET' && pathname === '/health') { send(res, 200, service.health()); return; }
      if (method === 'GET' && pathname === '/self/runtime') { send(res, 200, service.runtime()); return; }
      if (method === 'GET' && pathname === '/heartbeats') { send(res, 200, await service.listHeartbeats(url.searchParams.get('includeDead') === '1')); return; }
      if (method === 'GET' && pathname === '/wakeup-sources') {
        const agentId = required(url.searchParams.get('agentId'), 'agentId');
        send(res, 200, await service.listWakeupSources(agentId)); return;
      }
      const wakeupSourceMatch = pathname.match(/^\/wakeup-sources\/([^/]+)$/);
      if (wakeupSourceMatch && method === 'PUT') {
        const body = await readBody(req);
        const agentId = required(url.searchParams.get('agentId') ?? body.agentId, 'agentId');
        const cadence = required(body.cadence ?? url.searchParams.get('cadence'), 'cadence');
        send(res, 200, await service.registerWakeupSource(decodeURIComponent(wakeupSourceMatch[1]), agentId, cadence)); return;
      }
      if (wakeupSourceMatch && method === 'DELETE') {
        const agentId = required(url.searchParams.get('agentId'), 'agentId');
        send(res, 200, await service.deleteWakeupSource(decodeURIComponent(wakeupSourceMatch[1]), agentId)); return;
      }
      const heartbeatMatch = pathname.match(/^\/heartbeats\/([^/]+)$/);
      if (method === 'DELETE' && heartbeatMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        const result = await service.deleteHeartbeat(decodeURIComponent(heartbeatMatch[1]), reason);
        send(res, typeof result === 'object' && result && 'retirementPending' in result && (result as any).retirementPending ? 202 : 200, result); return;
      }
      if (method === 'GET' && pathname === '/children') {
        const agentId = required(url.searchParams.get('agentId'), 'agentId');
        send(res, 200, await service.listChildren(agentId)); return;
      }
      const childExactMatch = pathname.match(/^\/children\/([^/]+)$/);
      if ((method === 'DELETE' || method === 'PUT') && childExactMatch) {
        const body = await readBody(req);
        const managerId = required(url.searchParams.get('agentId') ?? body.agentId, 'agentId');
        const childId = decodeURIComponent(childExactMatch[1]);
        if (method === 'DELETE') {
          const reason = required(body.reason, 'reason');
          const result = await service.unsubscribeChildWatch(managerId, childId, reason);
          send(res, result.retirementPending ? 202 : 200, result); return;
        }
        send(res, 200, await service.resubscribeChildWatch(managerId, childId, typeof body.reason === 'string' ? body.reason : undefined)); return;
      }
      if (method === 'POST' && pathname === '/reminders') {
        const body = await readBody(req);
        if (body.id !== undefined) invalidValue('caller-supplied reminder id is not supported', 'id');
        const agentId = required(url.searchParams.get('agentId') ?? body.agentId, 'agentId'); required(body.message, 'message');
        send(res, 201, await service.createReminder({ ...body, agentId })); return;
      }
      if (method === 'GET' && pathname === '/reminders') {
        send(res, 200, service.listReminders(url.searchParams.get('agentId') || undefined)); return;
      }
      if (method === 'POST' && pathname === '/idle-reminders') {
        const body = await readBody(req);
        required(body.agentId, 'agentId'); required(body.message, 'message');
        send(res, 201, await service.createIdleReminder(body)); return;
      }
      if (method === 'GET' && pathname === '/idle-reminders') {
        send(res, 200, await service.listIdleReminders(url.searchParams.get('agentId') || undefined)); return;
      }
      const idleReminderMatch = pathname.match(/^\/idle-reminders\/([^/]+)$/);
      if (method === 'DELETE' && idleReminderMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        send(res, 200, await service.deleteIdleReminder(decodeURIComponent(idleReminderMatch[1]), reason)); return;
      }
      if (method === 'POST' && pathname === '/messages') {
        const body = await readBody(req);
        required(body.to, 'to'); required(body.from, 'from'); required(body.body, 'body');
        if (body.urgency !== undefined && body.urgency !== 'normal' && body.urgency !== 'urgent') invalidValue('urgency must be normal or urgent', 'urgency', ['normal', 'urgent']);
        const { promptKind: _internalPromptKind, actionCommand: _internalActionCommand, kind: _internalKind, recoveryManagerId: _internalRecoveryManagerId, recoveryCounts: _internalRecoveryCounts, recoveryRunIds: _internalRecoveryRunIds, ...publicBody } = body;
        send(res, 201, await service.postMessage(publicBody)); return;
      }
      if (method === 'GET' && pathname === '/messages') {
        send(res, 200, service.getMessages({
          to: url.searchParams.get('to') || undefined,
          from: url.searchParams.get('from') || undefined,
          status: url.searchParams.get('status') || undefined,
          replyTo: url.searchParams.get('replyTo') || undefined,
        })); return;
      }
      const messageMatch = pathname.match(/^\/messages\/([^/]+)$/);
      if (method === 'DELETE' && messageMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        const result = await service.deleteMessage(decodeURIComponent(messageMatch[1]), reason);
        send(res, result.retirementPending ? 202 : 200, result); return;
      }
      const reminderMatch = pathname.match(/^\/reminders\/([^/]+)$/);
      if (method === 'GET' && reminderMatch) {
        send(res, 200, service.getReminder(decodeURIComponent(reminderMatch[1]))); return;
      }
      if (method === 'DELETE' && reminderMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        const result = await service.deleteReminder(decodeURIComponent(reminderMatch[1]), reason);
        send(res, typeof result === 'object' && result && 'retirementPending' in result && (result as any).retirementPending ? 202 : 200, result); return;
      }
      const childWatchMatch = pathname.match(/^\/children\/([^/]+)\/watch$/);
      if ((method === 'DELETE' || method === 'PUT') && childWatchMatch) {
        const body = await readBody(req);
        const managerId = required(url.searchParams.get('agentId') ?? body.agentId, 'agentId');
        const childId = decodeURIComponent(childWatchMatch[1]);
        if (method === 'DELETE') {
          const reason = required(body.reason, 'reason');
          const result = await service.unsubscribeChildWatch(managerId, childId, reason);
          send(res, result.retirementPending ? 202 : 200, result); return;
        }
        send(res, 200, await service.resubscribeChildWatch(managerId, childId, typeof body.reason === 'string' ? body.reason : undefined)); return;
      }
      if (method === 'POST' && pathname === '/compact-wake') {
        const body = await readBody(req);
        required(body.agentId, 'agentId'); required(body.compact, 'compact');
        send(res, 202, await service.compactWake(body)); return;
      }
      const briefingMatch = pathname.match(/^\/children\/([^/]+)\/briefing$/);
      if (method === 'GET' && briefingMatch) {
        send(res, 200, await service.briefing(decodeURIComponent(briefingMatch[1]), url.searchParams.get('since') || undefined)); return;
      }
      if (method === 'POST' && pathname === '/ledger') {
        const body = await readBody(req);
        required(body.target, 'target');
        send(res, 201, await service.addLedger(body)); return;
      }
      if (method === 'GET' && pathname === '/ledger') {
        send(res, 200, service.listLedger(url.searchParams.get('type') || undefined, url.searchParams.get('target') || undefined)); return;
      }
      if (method === 'POST' && pathname === '/corrections') {
        const body = await readBody(req);
        const managerId = required(body.managerId, 'managerId');
        const auditorId = required(body.auditorId, 'auditorId');
        send(res, 201, await service.createCorrection({ managerId, auditorId, findings: body.findings })); return;
      }
      if (method === 'GET' && pathname === '/corrections') {
        send(res, 200, service.listCorrections(url.searchParams.get('managerId') || undefined, url.searchParams.get('status') || undefined)); return;
      }
      const correctionResolveMatch = pathname.match(/^\/corrections\/([^/]+)\/resolve$/);
      if (method === 'POST' && correctionResolveMatch) {
        const body = await readBody(req);
        send(res, 200, await service.resolveCorrection(decodeURIComponent(correctionResolveMatch[1]), {
          findingId: body.findingId,
          verdict: body.verdict,
          note: body.note,
        })); return;
      }
      if (method === 'GET' && pathname === '/gate') {
        const managerId = required(url.searchParams.get('managerId'), 'managerId');
        send(res, 200, service.getCorrectionGate(managerId)); return;
      }
      const revokeMatch = pathname.match(/^\/ledger\/([^/]+)\/revoke$/);
      if (method === 'POST' && revokeMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        send(res, 200, await service.revokeLedger(decodeURIComponent(revokeMatch[1]), reason)); return;
      }
      send(res, 404, { error: 'not found', code: 'not_found', routes: ROUTES.map(([routeMethod, path, requiredFields]) => ({ method: routeMethod, path, requiredFields, possibleCodes: ['missing_field', 'invalid_value', 'not_found', 'ambiguous_id', 'state_corrupt', 'cli_error'] })) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const companionError = error instanceof CompanionError ? error : new CompanionError('cli_error', message);
      send(res, ERROR_STATUS[companionError.code] ?? 500, { error: companionError.message, code: companionError.code, ...(companionError.field ? { field: companionError.field } : {}), ...(companionError.allowed ? { allowed: companionError.allowed } : {}) });
    }
  });
  return { server, service };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const app = await createServer();
  app.service.setPort(port);
  app.server.listen(port, '127.0.0.1', () => console.log(`paseo-reminder listening on http://127.0.0.1:${port}`));
}
