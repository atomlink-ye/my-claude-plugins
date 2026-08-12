import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, connect as connectSocket } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { materializeCubeSandboxEnv } from "./cube-sandbox-user-config.mjs";

const PROTOCOL_VERSION = 1;
const DEFAULT_SANDBOX_TIMEOUT_MS = 1_800_000;
// Keep the daemon address stable across agent shells and login sessions.  In
// particular, TMPDIR and XDG_RUNTIME_DIR can differ between the human shell
// and a paseo-launched agent, which must still attach to the same per-user
// daemon.
const DEFAULT_RUNTIME_DIR = path.join("/tmp", `sandbox-ctl-${process.getuid?.() ?? "user"}`);
const DEFAULT_SOCKET_PATH = path.join(DEFAULT_RUNTIME_DIR, "cube-sandbox.sock");
const DEFAULT_STATE_PATH = path.join(DEFAULT_RUNTIME_DIR, "cube-sandbox-state.json");
const DEFAULT_LOCK_PATH = path.join(DEFAULT_RUNTIME_DIR, "cube-sandbox.lock");
// These are intentionally not public configuration knobs. They are set only
// on the detached daemon child by startDaemon; the daemon entrypoint consumes
// them once and turns them into explicit runtimePaths options.
const CHILD_PATH_ENVS = {
  runtimeDir: "SANDBOX_CTL_DAEMON_RUNTIME_DIR_INTERNAL",
  socketPath: "SANDBOX_CTL_DAEMON_SOCKET_PATH_INTERNAL",
  statePath: "SANDBOX_CTL_DAEMON_STATE_PATH_INTERNAL",
  lockPath: "SANDBOX_CTL_DAEMON_LOCK_PATH_INTERNAL",
};

function runtimePaths(options = {}) {
  const runtimeDir = options.runtimeDir || process.env.SANDBOX_CTL_RUNTIME_DIR || DEFAULT_RUNTIME_DIR;
  return {
    runtimeDir,
    socketPath: options.socketPath || path.join(runtimeDir, "cube-sandbox.sock"),
    statePath: options.statePath || path.join(runtimeDir, "cube-sandbox-state.json"),
    lockPath: options.lockPath || path.join(runtimeDir, "cube-sandbox.lock"),
  };
}

function sanitizeUrl(value) {
  if (!value) return "";
  try {
    const original = String(value);
    const url = new URL(original);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const rendered = url.toString();
    return /^https?:\/\/[^/]+(?:[?#].*)?$/i.test(original) ? rendered.replace(/\/$/, "") : rendered;
  } catch {
    return String(value).replace(/:[^/@\s]+@/g, "@").replace(/[?].*$/, "");
  }
}

// Keep the URL's redacted components represented in the daemon identity
// without ever persisting their contents.  This prevents a credentials/query
// change from silently reusing an existing daemon while keeping state files
// free of URL secrets.
function urlSensitiveDigest(value) {
  if (!value) return "";
  let sensitive;
  try {
    const url = new URL(String(value));
    sensitive = [url.username, url.password, url.search, url.hash].join("\u0000");
  } catch {
    const raw = String(value);
    const userinfo = raw.match(/^https?:\/\/([^/@]+)@/i)?.[1] ?? "";
    const query = raw.match(/\?([^#\s]*)/i)?.[1] ?? "";
    const hash = raw.match(/#([^\s]*)/i)?.[1] ?? "";
    sensitive = [userinfo, query, hash].join("\u0000");
  }
  return sensitive.replaceAll("\u0000", "") ? `sha256:${createHash("sha256").update(sensitive).digest("hex")}` : "";
}

function connectionFingerprint(env = process.env) {
  materializeCubeSandboxEnv(env);
  const endpoint = env.CUBE_API_URL || env.E2B_API_URL || "";
  const proxy = env.CUBE_PROXY_URL || env.E2B_PROXY_URL || "";
  const caPath = env.CUBE_CA_PATH || env.E2B_CA_PATH || env.NODE_EXTRA_CA_CERTS || "";
  const apiKey = env.CUBE_API_KEY || env.E2B_API_KEY || "";
  return {
    apiUrl: sanitizeUrl(endpoint), proxy: sanitizeUrl(proxy),
    apiUrlSensitiveDigest: urlSensitiveDigest(endpoint),
    proxySensitiveDigest: urlSensitiveDigest(proxy),
    apiKeyDigest: apiKey ? `sha256:${createHash("sha256").update(String(apiKey)).digest("hex")}` : "",
    caPath: String(caPath),
    proxyNodeIp: String(env.CUBE_PROXY_NODE_IP || ""),
    apiNodeIp: String(env.CUBE_API_NODE_IP || env.CUBE_PROXY_NODE_IP || ""),
    sandboxDomain: String(env.CUBE_API_SANDBOX_DOMAIN || "cube.app"),
    proxyPortHttps: String(env.CUBE_PROXY_PORT_HTTPS || "443"),
  };
}

function daemonEnvironment(env = process.env) {
  materializeCubeSandboxEnv(env);
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LANG", "LC_ALL", "LC_CTYPE"]);
  for (const key of Object.keys(env)) if (/^(CUBE|E2B|SSL_CERT|HTTPS?_PROXY|NO_PROXY|SANDBOX_CTL_RUNTIME_DIR|SANDBOX_CTL_USER_CONFIG|XDG_CONFIG_HOME|NODE_OPTIONS|NODE_TLS)/.test(key)) allowed.add(key);
  return Object.fromEntries([...allowed].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

function daemonChildEnvironment(paths, env = process.env) {
  const childEnv = daemonEnvironment(env);
  childEnv.SANDBOX_CTL_RUNTIME_DIR = paths.runtimeDir;
  for (const [key, envName] of Object.entries(CHILD_PATH_ENVS)) childEnv[envName] = paths[key];
  return childEnv;
}

function ensureRuntimeDir(runtimeDir) {
  let info;
  try {
    info = lstatSync(runtimeDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    info = lstatSync(runtimeDir);
  }
  if (info.isSymbolicLink()) throw protocolError(`Refusing symlinked daemon runtime directory: ${runtimeDir}`);
  if (!info.isDirectory()) throw protocolError(`Daemon runtime path is not a directory: ${runtimeDir}`);
  if (process.getuid && info.uid !== process.getuid()) throw protocolError(`Daemon runtime directory is not owned by the current user: ${runtimeDir}`);
  chmodSync(runtimeDir, 0o700);

  // Re-read after chmod so a replacement/race cannot leave us believing that
  // an untrusted path is the private runtime directory.
  info = lstatSync(runtimeDir);
  if (info.isSymbolicLink()) throw protocolError(`Refusing symlinked daemon runtime directory: ${runtimeDir}`);
  if (!info.isDirectory()) throw protocolError(`Daemon runtime path is not a directory: ${runtimeDir}`);
  if (process.getuid && info.uid !== process.getuid()) throw protocolError(`Daemon runtime directory is not owned by the current user: ${runtimeDir}`);
  if ((info.mode & 0o777) !== 0o700) throw protocolError(`Daemon runtime directory must be mode 0700: ${runtimeDir}`);
}

function readState(statePath) {
  try {
    if (lstatSync(statePath).isSymbolicLink()) return null;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return sanitizeState(state);
  } catch { return null; }
}

function sanitizeState(state) {
  if (!state || typeof state !== "object") return null;
  const safeState = { ...state };
  delete safeState.apiKey;
  delete safeState.secret;
  if (safeState.proxyUrl) safeState.proxyUrl = sanitizeUrl(safeState.proxyUrl);
  if (safeState.fingerprint) safeState.fingerprint = {
    ...safeState.fingerprint,
    apiUrl: sanitizeUrl(safeState.fingerprint.apiUrl),
    proxy: sanitizeUrl(safeState.fingerprint.proxy),
  };
  if (safeState.fingerprint) {
    delete safeState.fingerprint.apiKey;
    delete safeState.fingerprint.secret;
  }
  return safeState;
}

function writeState(statePath, state) {
  try { if (lstatSync(statePath).isSymbolicLink()) throw protocolError(`Refusing symlinked daemon state: ${statePath}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const safeState = sanitizeState(state);
  writeFileSync(statePath, `${JSON.stringify(safeState)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function protocolError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function daemonRequestDeadline(payload = {}, options = {}) {
  if (payload.op === "exec" && Number.isFinite(Number(payload.timeoutMs))) return Math.max(1000, Number(payload.timeoutMs) + (options.requestGraceMs ?? 30000));
  return options.pingTimeoutMs ?? options.requestTimeoutMs ?? 1500;
}

function normalizeResult(result, stdout, stderr) {
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

export function createDaemonServer(options = {}) {
  const paths = runtimePaths(options);
  const createClient = options.createClient;
  const resolveRemoteHome = options.resolveRemoteHome;
  const connections = new Map();
  let client = options.client;
  let server;
  let closed = false;
  const sockets = new Set();

  async function closeResource(resource) {
    if (!resource) return;
    for (const method of ["disconnect", "close"]) {
      if (typeof resource[method] !== "function") continue;
      try { await resource[method](); return; }
      catch { /* try the alternate close hook when available */ }
    }
  }

  async function getConnection(sandboxId, remoteHome, sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS) {
    if (!sandboxId) throw protocolError("sandboxId is required");
    let entry = connections.get(sandboxId);
    if (!entry) {
      if (!client) {
        if (typeof createClient !== "function") throw protocolError("Cube Sandbox daemon has no client factory");
        client = await createClient();
      }
      const timeoutMs = Number.isSafeInteger(Number(sandboxTimeoutMs)) && Number(sandboxTimeoutMs) > 0
        ? Number(sandboxTimeoutMs)
        : DEFAULT_SANDBOX_TIMEOUT_MS;
      const sandbox = await client.connect(sandboxId, { timeoutMs });
      const home = remoteHome || (typeof resolveRemoteHome === "function" ? await resolveRemoteHome(sandbox) : undefined);
      entry = { sandbox, remoteHome: home };
      connections.set(sandboxId, entry);
    }
    return entry;
  }

  async function handleRequest(request, send) {
    if (!request || request.version !== PROTOCOL_VERSION) throw protocolError(`Unsupported daemon protocol version: ${request?.version ?? "missing"}`);
    if (request.op === "ping") return {
      ok: true,
      pid: process.pid,
      uid: process.getuid?.(),
      version: PROTOCOL_VERSION,
      ...(options.proxyUrl ? { proxyUrl: sanitizeUrl(options.proxyUrl) } : {}),
    };
    if (request.op === "invalidate") {
      if (!request.sandboxId) throw protocolError("sandboxId is required");
      const entry = connections.get(request.sandboxId);
      if (!entry) return { ok: true, invalidated: false, sandboxId: request.sandboxId };
      connections.delete(request.sandboxId);
      await closeResource(entry.sandbox);
      return { ok: true, invalidated: true, sandboxId: request.sandboxId };
    }
    if (request.op !== "exec") throw protocolError(`Unsupported daemon operation: ${request.op}`);
    const { sandbox, remoteHome } = await getConnection(request.sandboxId, request.remoteHome, request.sandboxTimeoutMs);
    const stdout = [];
    const stderr = [];
    const emit = (kind, chunk) => {
      const data = String(chunk ?? "");
      if (!data) return;
      (kind === "stderr" ? stderr : stdout).push(data);
      send({ version: PROTOCOL_VERSION, id: request.id, type: kind, data });
    };
    const runOptions = {
      background: false,
      cwd: request.cwd ? (request.cwd.startsWith("/") || !remoteHome ? request.cwd : path.posix.join(remoteHome, request.cwd)) : undefined,
      timeoutMs: request.timeoutMs,
      onStdout: (chunk) => emit("stdout", chunk),
      onStderr: (chunk) => emit("stderr", chunk),
    };
    let result;
    try {
      result = await sandbox.commands.run(String(request.command || ""), runOptions);
    } catch (error) {
      if (typeof error?.exitCode === "number") result = error;
      else throw protocolError(error?.message || String(error));
    }
    // Some fakes/SDK versions return buffered output without callbacks. Preserve it
    // while avoiding duplicate data when callbacks already streamed the same bytes.
    if (!stdout.length && result?.stdout) emit("stdout", result.stdout);
    if (!stderr.length && result?.stderr) emit("stderr", result.stderr);
    return { ...normalizeResult(result, stdout, stderr), remoteHome };
  }

  function accept(socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    const send = (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { send({ version: PROTOCOL_VERSION, type: "result", exitCode: 125, error: "Invalid daemon JSON request" }); continue; }
        send({ version: PROTOCOL_VERSION, id: request.id, type: "accepted" });
        Promise.resolve(handleRequest(request, send)).then((result) => send({ version: PROTOCOL_VERSION, id: request.id, type: "result", ...result })).catch((error) => send({ version: PROTOCOL_VERSION, id: request.id, type: "result", exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 125, error: String(error?.message || error) }));
      }
    });
  }

  async function listen() {
    ensureRuntimeDir(paths.runtimeDir);
    if (existsSync(paths.socketPath)) {
      try { if (lstatSync(paths.socketPath).isSymbolicLink()) throw protocolError(`Refusing symlinked daemon socket: ${paths.socketPath}`); } catch (error) { if (/symlinked/.test(error.message)) throw error; }
      try {
        await createDaemonClient({ socketPath: paths.socketPath, connectTimeoutMs: 150 }).ping();
        throw protocolError(`Cube Sandbox daemon already running at ${paths.socketPath}`);
      } catch (error) {
        if (/already running/.test(error.message)) throw error;
        try { unlinkSync(paths.socketPath); } catch { /* stale socket race; bind below is authoritative */ }
      }
    }
    server = createServer(accept);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socketPath, () => { chmodSync(paths.socketPath, 0o600); resolve(); }); });
    return api;
  }

  async function close() {
    closed = true;
    const resources = new Set([client, ...[...connections.values()].map((entry) => entry.sandbox)]);
    connections.clear();
    await Promise.all([...resources].map((resource) => closeResource(resource)));
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    try { if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath); } catch { /* best effort exact cleanup */ }
  }

  const api = { listen, close, handleRequest, socketPath: paths.socketPath, runtimeDir: paths.runtimeDir, get client() { return client; }, get closed() { return closed; }, connections };
  return api;
}

export function createDaemonClient(options = {}) {
  const socketPath = runtimePaths(options).socketPath;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1000;
  function request(payload, { onStdout, onStderr } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connectSocket(socketPath);
      const id = payload.id || randomUUID();
      const stdout = []; const stderr = [];
      let buffer = ""; let settled = false; let accepted = false;
      const finish = (fn, value) => { if (settled) return; settled = true; socket.destroy(); fn(value); };
      const timer = setTimeout(() => finish(reject, protocolError(`Cube Sandbox daemon is unreachable at ${socketPath}`)), connectTimeoutMs);
      let requestTimer;
      const requestDeadlineMs = daemonRequestDeadline(payload, options);
      socket.setEncoding("utf8");
      socket.on("connect", () => { clearTimeout(timer); requestTimer = setTimeout(() => finish(reject, protocolError(`Cube Sandbox daemon request timed out`)), requestDeadlineMs); socket.write(`${JSON.stringify({ version: PROTOCOL_VERSION, id, ...payload })}\n`); });
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
          let frame; try { frame = JSON.parse(line); } catch { continue; }
          if (frame.type === "accepted") { accepted = true; }
          else if (frame.type === "stdout") { stdout.push(String(frame.data ?? "")); onStdout?.(frame.data); }
          else if (frame.type === "stderr") { stderr.push(String(frame.data ?? "")); onStderr?.(frame.data); }
          else if (frame.type === "result") { clearTimeout(timer); clearTimeout(requestTimer); finish(resolve, { ...frame, stdout: frame.stdout ?? stdout.join(""), stderr: frame.stderr ?? stderr.join("") }); }
        }
      });
      socket.on("error", (error) => { clearTimeout(timer); clearTimeout(requestTimer); finish(reject, protocolError(`Cube Sandbox daemon is unreachable at ${socketPath}: ${error.message}`, { accepted })); });
      socket.on("close", () => { if (!settled) { clearTimeout(timer); clearTimeout(requestTimer); finish(reject, protocolError(`Cube Sandbox daemon closed before returning a result`, { accepted })); } });
    });
  }
  return {
    socketPath,
    ping: () => request({ op: "ping" }),
    invalidate: (sandboxId) => request({ op: "invalidate", sandboxId }),
    exec: (requestOptions) => request({ op: "exec", ...requestOptions }, requestOptions),
  };
}

function sameFingerprint(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

async function probeDaemon(paths) {
  let socketStat;
  try {
    socketStat = lstatSync(paths.socketPath);
    if (socketStat.isSymbolicLink()) return null;
    if (process.getuid && socketStat.uid !== process.getuid()) return null;
    const ping = await createDaemonClient(paths).ping();
    const currentUid = process.getuid?.();
    const sameUser = currentUid === undefined || (ping.uid !== undefined && Number(ping.uid) === Number(currentUid));
    if (!sameUser) return null;
    return { ping, socketStat };
  } catch {
    return null;
  }
}

export async function daemonStatus(options = {}) {
  const paths = runtimePaths(options);
  const state = readState(paths.statePath);
  const probe = await probeDaemon(paths);
  if (!probe) return { running: false, socketPath: paths.socketPath, state };
  const currentFingerprint = connectionFingerprint();
  const stateIdentity = Boolean(state?.pid && state?.fingerprint && Number(state.pid) === Number(probe.ping.pid)
    && (state.uid === undefined || probe.ping.uid === undefined || Number(state.uid) === Number(probe.ping.uid)));
  const fingerprintMatches = stateIdentity && sameFingerprint(state.fingerprint, currentFingerprint);
  if (!stateIdentity || !fingerprintMatches) {
    // A listening socket without a matching state file is a startup/stop race,
    // not proof of a healthy daemon. Report it as not running so callers fail
    // closed instead of attaching to an unknown process.
    return {
      running: false,
      daemonDetected: true,
      identityError: !stateIdentity ? `daemon state identity is unavailable at ${paths.socketPath}` : `daemon connection settings changed at ${paths.socketPath}`,
      pid: probe.ping.pid,
      uid: probe.ping.uid,
      socketPath: paths.socketPath,
      state,
    };
  }
  return { running: true, ...probe.ping, socketPath: paths.socketPath, state };
}

export async function startDaemon(options = {}) {
  const paths = runtimePaths(options);
  ensureRuntimeDir(paths.runtimeDir);
  const status = await daemonStatus(paths);
  if (status.running) {
    return status;
  }
  if (status.daemonDetected) {
    throw protocolError(`Cube Sandbox daemon identity is indeterminate (${status.identityError}); stop it from the owning environment before starting`);
  }
  if (existsSync(paths.lockPath)) {
    try { const lock = JSON.parse(readFileSync(paths.lockPath, "utf8")); if (lock.pid) process.kill(lock.pid, 0); else throw new Error("stale"); throw protocolError("Cube Sandbox daemon start is already in progress; retry shortly"); }
    catch (error) { if (/already in progress/.test(error.message)) throw error; try { unlinkSync(paths.lockPath); } catch {} }
  }
  writeFileSync(paths.lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "cube-sandbox-daemon-process.mjs")], { detached: true, stdio: "ignore", env: daemonChildEnvironment(paths, process.env) });
    child.unref();
    const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      const next = await daemonStatus(paths);
      if (next.running) return next;
      // The child binds its socket before atomically publishing state. Keep
      // polling through that tiny window, but never treat the socket as ready.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw protocolError(`Cube Sandbox daemon failed to start at ${paths.socketPath}; check CUBE_API_URL and credentials, then retry`);
  } finally { try { unlinkSync(paths.lockPath); } catch {} }
}

export async function stopDaemon(options = {}) {
  const paths = runtimePaths(options);
  const probe = await probeDaemon(paths);
  if (probe?.ping?.pid) {
    // Socket ownership plus the ping UID are the authoritative identity when
    // state is missing or its fingerprint belongs to another environment.
    try { process.kill(Number(probe.ping.pid), "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const pid = Number(probe?.ping?.pid);
  const deadline = Date.now() + (options.stopTimeoutMs ?? 2000);
  let exited = !Number.isInteger(pid) || pid <= 1;
  while (!exited && Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") { exited = true; break; } }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!exited) return { running: true, stopped: false, pid, socketPath: paths.socketPath };
  try { unlinkSync(paths.socketPath); } catch {}
  try { unlinkSync(paths.statePath); } catch {}
  try { unlinkSync(paths.lockPath); } catch {}
  return { running: false, stopped: true, socketPath: paths.socketPath };
}

export { PROTOCOL_VERSION, connectionFingerprint, daemonChildEnvironment, daemonEnvironment, daemonRequestDeadline, ensureRuntimeDir, runtimePaths, readState, writeState };
