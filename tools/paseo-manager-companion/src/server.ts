import http from 'node:http';
import { URL } from 'node:url';
import { CompanionService } from './service.js';

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

export async function createServer(service = new CompanionService()): Promise<CompanionServer> {
  await service.init();
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;
      if (method === 'GET' && pathname === '/health') { send(res, 200, service.health()); return; }
      if (method === 'GET' && pathname === '/children') {
        const agentId = required(url.searchParams.get('agentId'), 'agentId');
        send(res, 200, await service.listChildren(agentId)); return;
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
      if (method === 'POST' && pathname === '/messages') {
        const body = await readBody(req);
        required(body.to, 'to'); required(body.from, 'from'); required(body.body, 'body');
        if (body.urgency !== undefined && body.urgency !== 'normal' && body.urgency !== 'urgent') throw new HttpError(400, 'urgency must be normal or urgent');
        send(res, 201, await service.postMessage(body)); return;
      }
      const reminderMatch = pathname.match(/^\/reminders\/([^/]+)$/);
      if (method === 'DELETE' && reminderMatch) {
        const body = await readBody(req);
        const reason = required(body.reason, 'reason');
        send(res, 200, await service.deleteReminder(decodeURIComponent(reminderMatch[1]), reason)); return;
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
      const status = error instanceof HttpError ? error.status : (/reminder not found|ledger record not found/.test(message) ? 404 : (/invalid ledger type|verdict and reason|delaySeconds must be positive/.test(message) ? 400 : (message.includes('not found') ? 404 : 500)));
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
