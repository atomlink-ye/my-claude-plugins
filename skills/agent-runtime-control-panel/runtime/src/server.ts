import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { homedir } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ArcpService } from './arcp.js';
import { handleArcp } from './arcp-server.js';

export interface ArcpServer {
  server: http.Server;
  arcp: ArcpService;
  /** Held from before the service was constructed, so the process that will be
   * refused never becomes a second writer against the data root. */
  ownership?: StartupOwnership;
}

export interface StartupOwnership { files: string[]; updatePort: (port: number) => void; release: () => void; }

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

/** The record that actually protects the data root. Ownership is a data-root
 * lifecycle concern, so the authoritative record always lives inside the root
 * it guards; two supervisors with different runtime dirs over one data root
 * therefore contend on the same file. */
function primaryOwnershipPath(dataDir: string): string { return path.join(path.resolve(dataDir), 'arcp.pid'); }

/** The launcher-visible record. `ensure-running` and older supervisors read
 * this path, so it is still written - but it is advisory, and a record naming a
 * different data root is left alone rather than treated as a conflict. */
function launcherOwnershipPath(dataDir: string): string | undefined {
  const explicit = process.env.ARCP_PID ?? process.env.PASEO_COMPANION_PID;
  if (explicit) return path.resolve(explicit);
  const runtimeDir = process.env.ARCP_RUNTIME_DIR ?? process.env.PASEO_COMPANION_RUNTIME_DIR;
  const file = runtimeDir ? path.join(path.resolve(runtimeDir), 'arcp.pid') : undefined;
  return file && file !== primaryOwnershipPath(dataDir) ? file : undefined;
}

/** Exported for the launcher and for tests: the paths this data root claims. */
export function ownershipPaths(dataDir: string): string[] {
  return [primaryOwnershipPath(dataDir), ...(launcherOwnershipPath(dataDir) ? [launcherOwnershipPath(dataDir)!] : [])];
}

interface OwnershipRecord { pid?: number; dataDir?: string; processStart?: string }

export function dataRootFingerprint(dataDir: string): string { return createHash('sha256').update(path.resolve(dataDir)).digest('hex'); }

/** `kill(pid, 0)` alone is unsafe after pid reuse. `ps lstart` provides the
 * process epoch used to tell a recycled pid from the recorded owner. */
function processStartIdentity(pid: number): string | undefined {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

function ownershipRecord(file: string): OwnershipRecord | undefined {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const parsed = raw.startsWith('{') ? JSON.parse(raw) : { pid: raw };
    const pid = Number(parsed.pid);
    return { ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}), ...(typeof parsed.dataDir === 'string' ? { dataDir: path.resolve(parsed.dataDir) } : {}), ...(typeof parsed.processStart === 'string' && parsed.processStart.trim() ? { processStart: parsed.processStart.trim() } : {}) };
  } catch { return undefined; }
}

function recordedPid(file: string): number | undefined { return ownershipRecord(file)?.pid; }

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}

function removeIfOwned(file: string, pid: number): void {
  if (recordedPid(file) === pid) try { unlinkSync(file); } catch { /* already gone */ }
}

function removeFile(file: string): void { try { unlinkSync(file); } catch { /* already gone */ } }

export const OWNERSHIP_TAKEOVER_HINT = 'the recorded process is still live; stop it or restore its health before starting another owner';

function writeOwnership(file: string, dataDir: string, port: number, exclusive: boolean): void {
  const payload = JSON.stringify({ pid: process.pid, port, dataDir: path.resolve(dataDir), processStart: processStartIdentity(process.pid), startedAt: new Date().toISOString() }) + '\n';
  if (!exclusive) { writeFileSync(file, payload, { mode: 0o600 }); return; }
  const descriptor = openSync(file, 'wx', 0o600);
  try { writeFileSync(descriptor, payload); } finally { closeSync(descriptor); }
}

/** Claim the durable data-root owner record before the service is constructed.
 * The port remains the final arbiter, but this prevents two supervisors from
 * racing to it - and, more importantly, from both writing the same store. */
function claimOwnership(dataDir: string, port: number): StartupOwnership {
  const root = path.resolve(dataDir);
  const primary = primaryOwnershipPath(dataDir); mkdirSync(path.dirname(primary), { recursive: true });
  const existing = ownershipRecord(primary);
  if (existing?.pid && isLive(existing.pid)) {
    const currentStart = processStartIdentity(existing.pid);
    // An epoch mismatch proves pid reuse. If the old row predates epochs (or
    // `ps` is unavailable), retain it: deleting a live owner would split the
    // data-root writer authority.
    if (!existing.processStart || !currentStart || existing.processStart === currentStart) throw new ArcpStartupOwnershipError('arcp_owner_active', `ARCP ownership of ${root} is held by live pid ${existing.pid} (${primary}); ${OWNERSHIP_TAKEOVER_HINT}`);
  }
  if (existing) removeFile(primary);
  try { writeOwnership(primary, root, port, true); }
  catch (error: any) {
    if (error?.code === 'EEXIST') throw new ArcpStartupOwnershipError('arcp_owner_active', `ARCP ownership record for ${root} appeared while starting (${primary})`);
    throw error;
  }
  // The launcher-visible record is advisory. A live record naming a different
  // data root belongs to another supervisor and is left untouched, so two
  // distinct data roots sharing one runtime dir no longer falsely conflict.
  const launcher = launcherOwnershipPath(dataDir);
  const files = [primary];
  if (launcher) {
    const other = ownershipRecord(launcher);
    const foreign = Boolean(other?.pid && isLive(other.pid) && other?.dataDir && other.dataDir !== root);
    if (!foreign) { try { mkdirSync(path.dirname(launcher), { recursive: true }); writeOwnership(launcher, root, port, false); files.push(launcher); } catch { /* advisory only */ } }
  }
  return {
    files,
    updatePort: (boundPort) => { for (const file of files) try { writeOwnership(file, root, boundPort, false); } catch { /* advisory only */ } },
    release: () => { for (const file of files) removeIfOwned(file, process.pid); },
  };
}

/** Ownership is claimed here, before `ArcpService` is constructed. `init()`
 * migrates identities and runs the pump, so a duplicate that claims afterwards
 * has already written into - and raced the live owner over - a data root it is
 * then refused. */
export async function createServer(dataDir = resolveDataDir(), port = 0): Promise<ArcpServer> {
  const ownership = claimOwnership(dataDir, port);
  let arcp: ArcpService;
  try { arcp = new ArcpService(dataDir); await arcp.init(); }
  catch (error) { ownership.release(); throw error; }
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
        send(res, 200, { pid: runtime.pid, port: runtime.port, dataRootFingerprint: dataRootFingerprint(String(runtime.dataDir ?? '')) }); return;
      }
      send(res, 404, { code: 'not_found', message: 'ARCP serves /v1, /health and /self/runtime only' });
    } catch (error) {
      send(res, 500, { code: 'internal_error', message: error instanceof Error ? error.message : 'internal error' });
    }
  });
  return { server, arcp, ownership };
}

/** Start one owner for a state root. This deliberately turns a port collision
 * into a classified startup failure instead of an unhandled EventEmitter error. */
export async function startServer(app: ArcpServer, port: number, dataDir = resolveDataDir()): Promise<void> {
  const ownership = app.ownership ?? claimOwnership(dataDir, port);
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
  const unregister = releaseOwnershipOnSignal(ownership);
  app.server.once('close', () => { unregister(); ownership.release(); });
}

/** A signalled server never emits `close`, so without this it leaves a record
 * naming a dead pid - which becomes an unrecoverable wedge once the OS recycles
 * that pid. Release first, then let the default disposition take effect. */
export function releaseOwnershipOnSignal(ownership: StartupOwnership, reraise: (signal: NodeJS.Signals) => void = (signal) => process.kill(process.pid, signal)): () => void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    // Release, then hand the signal back to its default disposition so the
    // process still dies exactly as an unhandled signal would.
    const handler = () => { ownership.release(); process.off(signal, handler); reraise(signal); };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 18787);
  try {
    const app = await createServer(resolveDataDir(), port);
    app.arcp.setPort(port);
    await startServer(app, port);
    console.log(`ARCP listening on http://127.0.0.1:${port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ARCP failed to start');
    process.exitCode = error instanceof ArcpStartupOwnershipError ? 3 : 1;
  }
}
