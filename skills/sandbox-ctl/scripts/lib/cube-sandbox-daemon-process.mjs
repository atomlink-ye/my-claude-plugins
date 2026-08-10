#!/usr/bin/env node

import { unlinkSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createDaemonServer, connectionFingerprint, readState, runtimePaths, writeState } from "./cube-sandbox-daemon.mjs";
import { createClient, resolveRemoteHome } from "../adapters/cube-sandbox-manager.mjs";
import { ensureCubeProxy } from "./cube-sandbox-proxy.mjs";

const CHILD_PATH_ENVS = {
  runtimeDir: "SANDBOX_CTL_DAEMON_RUNTIME_DIR_INTERNAL",
  socketPath: "SANDBOX_CTL_DAEMON_SOCKET_PATH_INTERNAL",
  statePath: "SANDBOX_CTL_DAEMON_STATE_PATH_INTERNAL",
  lockPath: "SANDBOX_CTL_DAEMON_LOCK_PATH_INTERNAL",
};

export function daemonPathsFromEnvironment(env = process.env) {
  const options = {};
  for (const [key, envName] of Object.entries(CHILD_PATH_ENVS)) {
    if (env[envName]) options[key] = env[envName];
    delete env[envName];
  }
  return runtimePaths(options);
}

async function runDaemon() {
  const paths = daemonPathsFromEnvironment();
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
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runDaemon();
