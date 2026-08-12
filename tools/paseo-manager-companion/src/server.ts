import http from 'node:http';
import { URL } from 'node:url';
import { CompanionService } from './service.js';
import { PaseoScheduleObserver } from './schedule-observer.js';

export interface CompanionServer {
  server: http.Server;
  service: CompanionService;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) data += String(chunk);
  if (!data.trim()) return {};
  try { return JSON.parse(data); } catch { throw new HttpError(400, 'invalid JSON'); }
}
function send(res: http.ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value;
}

export async function createServer(service = new CompanionService(undefined, undefined, new PaseoScheduleObserver())): Promise<CompanionServer> {
  await service.init();
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;
      if (method === 'GET' && pathname === '/health') { send(res, 200, service.health()); return; }
      if (method === 'GET' && pathname === '/heartbeats') { send(res, 200, await service.listHeartbeats()); return; }
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
      if (method === 'POST' && pathname === '/spawn') {
        const body = await readBody(req);
        required(body.provider, 'provider'); required(body.title, 'title'); required(body.cwd, 'cwd'); required(body.prompt, 'prompt');
        send(res, 201, await service.spawn(body, process.env.PASEO_AGENT_ID)); return;
      }
      if (method === 'POST' && pathname === '/reminders') {
        const body = await readBody(req);
        required(body.agentId, 'agentId'); required(body.message, 'message');
        send(res, 201, await service.createReminder(body)); return;
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
        if (body.urgency !== undefined && body.urgency !== 'normal' && body.urgency !== 'urgent') throw new HttpError(400, 'urgency must be normal or urgent');
        send(res, 201, await service.postMessage(body)); return;
      }
      if (method === 'GET' && pathname === '/messages') {
        send(res, 200, service.getMessages(url.searchParams.get('to') || undefined)); return;
      }
      const messageMatch = pathname.match(/^\/messages\/([^/]+)$/);
      if (method === 'DELETE' && messageMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        const result = await service.deleteMessage(decodeURIComponent(messageMatch[1]), reason);
        send(res, result.retirementPending ? 202 : 200, result); return;
      }
      const reminderMatch = pathname.match(/^\/reminders\/([^/]+)$/);
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
        required(body.agentId, 'agentId'); required(body.resumeSteps, 'resumeSteps');
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
      const revokeMatch = pathname.match(/^\/ledger\/([^/]+)\/revoke$/);
      if (method === 'POST' && revokeMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        send(res, 200, await service.revokeLedger(decodeURIComponent(revokeMatch[1]), reason)); return;
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError ? error.status : (/heartbeat id ambiguous/.test(message) ? 409 : (/child-watch opt-out state corrupt/.test(message) ? 503 : (/reminder not found|idle reminder not found|message not found|ledger record not found|heartbeat not found|wakeup source not found/.test(message) ? 404 : (/invalid ledger type|verdict and reason|reason is required|delaySeconds must be positive|maxRuns must be a positive integer|thresholdSeconds must be positive|agentId, childId, and reason|agentId and childId|heartbeatId, agentId, and cadence/.test(message) ? 400 : (message.includes('not found') ? 404 : 500)))));
      send(res, status, { error: message });
    }
  });
  return { server, service };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const app = await createServer();
  app.service.setPort(port);
  app.server.listen(port, '127.0.0.1', () => console.log(`paseo-manager-companion listening on http://127.0.0.1:${port}`));
}
