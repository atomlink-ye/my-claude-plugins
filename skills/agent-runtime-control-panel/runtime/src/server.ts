import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { homedir } from 'node:os';
import { ArcpService } from './arcp.js';
import { handleArcp } from './arcp-server.js';

export interface ArcpServer {
  server: http.Server;
  arcp: ArcpService;
}

function send(res: http.ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

/** Durable state directory. `PASEO_COMPANION_DATA` is accepted as a path name
 * only, so a state directory created under the older name stays readable. */
export function resolveDataDir(): string {
  const explicit = process.env.ARCP_DATA ?? process.env.PASEO_COMPANION_DATA;
  if (explicit) return explicit;
  const state = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state');
  return path.join(state, 'agent-runtime-control-panel/data');
}

export async function createServer(dataDir = resolveDataDir()): Promise<ArcpServer> {
  const arcp = new ArcpService(dataDir);
  await arcp.init();
  const server = http.createServer(async (req, res) => {
    try {
      if (await handleArcp(req, res, arcp)) return;
      const method = req.method || 'GET';
      const pathname = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname;
      // `/health` is the launcher's liveness probe and stays unauthenticated.
      // `/self/runtime` reports only pid and port once a key is configured.
      if (method === 'GET' && pathname === '/health') { send(res, 200, arcp.health()); return; }
      const apiKey = process.env.ARCP_API_KEY ?? process.env.PASEO_COMPANION_API_KEY;
      if (method === 'GET' && pathname === '/self/runtime') {
        const runtime = arcp.runtime();
        if (!apiKey) { send(res, 200, runtime); return; }
        const supplied = String(req.headers['x-arcp-api-key'] ?? '');
        if (supplied !== apiKey) { send(res, 401, { code: 'unauthorized' }); return; }
        send(res, 200, { pid: runtime.pid, port: runtime.port }); return;
      }
      send(res, 404, { code: 'not_found', message: 'ARCP serves /v1, /health and /self/runtime only' });
    } catch (error) {
      send(res, 500, { code: 'internal_error', message: error instanceof Error ? error.message : 'internal error' });
    }
  });
  return { server, arcp };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 18787);
  const app = await createServer();
  app.arcp.setPort(port);
  app.server.listen(port, '127.0.0.1', () => console.log(`ARCP listening on http://127.0.0.1:${port}`));
}
