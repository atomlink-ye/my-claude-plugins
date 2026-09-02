import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { homedir } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { ArcpService } from './arcp.js';
import { handleArcp } from './arcp-server.js';

export interface ArcpServer {
  server: http.Server;
  arcp: ArcpService;
}

export class ArcpStartupOwnershipError extends Error {
  constructor(readonly code: 'arcp_owner_active' | 'arcp_port_in_use', message: string) { super(message); }
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

function ownershipPath(dataDir: string): string {
  return process.env.ARCP_PID ?? process.env.PASEO_COMPANION_PID ?? path.join(process.env.ARCP_RUNTIME_DIR ?? process.env.PASEO_COMPANION_RUNTIME_DIR ?? dataDir, 'arcp.pid');
}

function recordedPid(file: string): number | undefined {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const value = raw.startsWith('{') ? JSON.parse(raw).pid : raw;
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}

function removeIfOwned(file: string, pid: number): void {
  if (recordedPid(file) === pid) try { unlinkSync(file); } catch { /* already gone */ }
}

function removeFile(file: string): void { try { unlinkSync(file); } catch { /* already gone */ } }

/** Claim the durable data-root owner record before binding. The port remains
 * the final arbiter, but this prevents two supervisors from racing to it. */
function claimOwnership(dataDir: string, port: number): { file: string; updatePort: (port: number) => void; release: () => void } {
  const file = ownershipPath(dataDir); mkdirSync(path.dirname(file), { recursive: true });
  const existing = recordedPid(file);
  if (existing && isLive(existing)) throw new ArcpStartupOwnershipError('arcp_owner_active', `ARCP ownership is held by live pid ${existing} (${file})`);
  if (existing || (() => { try { readFileSync(file); return true; } catch { return false; } })()) removeFile(file);
  try {
    const descriptor = openSync(file, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, port, dataDir: path.resolve(dataDir), startedAt: new Date().toISOString() }) + '\n');
    closeSync(descriptor);
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new ArcpStartupOwnershipError('arcp_owner_active', `ARCP ownership record appeared while starting (${file})`);
    throw error;
  }
  return {
    file,
    updatePort: (boundPort) => writeFileSync(file, JSON.stringify({ pid: process.pid, port: boundPort, dataDir: path.resolve(dataDir), startedAt: new Date().toISOString() }) + '\n'),
    release: () => removeIfOwned(file, process.pid),
  };
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

/** Start one owner for a state root. This deliberately turns a port collision
 * into a classified startup failure instead of an unhandled EventEmitter error. */
export async function startServer(app: ArcpServer, port: number, dataDir = resolveDataDir()): Promise<void> {
  const ownership = claimOwnership(dataDir, port);
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      ownership.release();
      reject(error.code === 'EADDRINUSE'
        ? new ArcpStartupOwnershipError('arcp_port_in_use', `ARCP port ${port} is already in use`)
        : error);
    };
    app.server.once('error', failed);
    app.server.listen(port, '127.0.0.1', () => {
      app.server.off('error', failed);
      const address = app.server.address(); ownership.updatePort(typeof address === 'object' && address ? address.port : port);
      resolve();
    });
  });
  app.server.once('close', ownership.release);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 18787);
  try {
    const app = await createServer();
    app.arcp.setPort(port);
    await startServer(app, port);
    console.log(`ARCP listening on http://127.0.0.1:${port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ARCP failed to start');
    process.exitCode = error instanceof ArcpStartupOwnershipError ? 3 : 1;
  }
}
