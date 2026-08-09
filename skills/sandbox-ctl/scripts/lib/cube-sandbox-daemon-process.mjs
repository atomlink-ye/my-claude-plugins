#!/usr/bin/env node

import { unlinkSync } from "node:fs";
import { createDaemonServer, connectionFingerprint, readState, runtimePaths, writeState } from "./cube-sandbox-daemon.mjs";
import { createClient, resolveRemoteHome } from "../adapters/cube-sandbox-manager.mjs";
import { ensureCubeProxy } from "./cube-sandbox-proxy.mjs";

const paths = runtimePaths();
const previous = readState(paths.statePath);
const fingerprint = connectionFingerprint();
if (previous?.fingerprint && JSON.stringify(previous.fingerprint) !== JSON.stringify(fingerprint)) {
  process.stderr.write("Cube Sandbox daemon connection settings changed; run sandbox-ctl daemon stop then sandbox-ctl daemon start.\n");
  process.exit(1);
}

let localProxy;
if (!process.env.CUBE_PROXY_URL && process.env.CUBE_PROXY_NODE_IP) {
  localProxy = await ensureCubeProxy(process.env);
  process.env.CUBE_PROXY_URL = localProxy.url;
}
let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { if (server) await server.close(); } finally {
    try { await localProxy?.close(); } catch {}
    try { unlinkSync(paths.statePath); } catch {}
    try { unlinkSync(paths.lockPath); } catch {}
  }
}
process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
process.once("SIGINT", () => stop().finally(() => process.exit(0)));
try {
  // Validate credentials and construct exactly one SDK client at daemon boot.
  // It is retained by createDaemonServer for every subsequent exec.
  const client = await createClient();
  server = createDaemonServer({ ...paths, client, resolveRemoteHome, proxyUrl: localProxy?.url || process.env.CUBE_PROXY_URL });
  await server.listen();
  writeState(paths.statePath, { version: 1, pid: process.pid, uid: process.getuid?.(), socketPath: paths.socketPath, fingerprint, ...(localProxy?.url || process.env.CUBE_PROXY_URL ? { proxyUrl: localProxy?.url || process.env.CUBE_PROXY_URL } : {}) });
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  await stop();
  process.exitCode = 1;
}
