import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

import { HOSTNAME, STARTUP_TIMEOUT_MS, STATE_FILE_NAME } from "./constants.mjs";
import { runtimeStateDirectory, stateFilePath } from "./config.mjs";
import { checkHealth } from "./http-client.mjs";
import { delay, isPidRunning, log, runCommandCapture, terminateProcess } from "./process-utils.mjs";
import { firstNonEmptyLine } from "./text-utils.mjs";

export function readState(directory) {
  const filename = stateFilePath(directory);
  if (!fs.existsSync(filename)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${STATE_FILE_NAME}: ${error.message}`);
  }
}

export function writeState(directory, state) {
  fs.writeFileSync(stateFilePath(directory), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function removeState(directory) {
  fs.rmSync(stateFilePath(directory), { force: true });
}

export function opencodeEnv(directory) {
  const stateRoot = runtimeStateDirectory(directory);
  fs.mkdirSync(stateRoot, { recursive: true });
  return {
    ...process.env,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME || stateRoot
  };
}

export async function ensureOpencodeInstalled(directory) {
  const result = await runCommandCapture("opencode", ["--version"], {
    cwd: directory,
    env: opencodeEnv(directory),
    timeoutMs: 5000
  });

  if (result.error?.code === "ENOENT") {
    throw new Error(
      "OpenCode CLI is not installed or is not on PATH. Install it first, then rerun `node scripts/opencode-companion.mjs check`."
    );
  }

  if (result.timedOut) {
    throw new Error("Timed out while checking the OpenCode CLI.");
  }

  if (result.exitCode !== 0) {
    const details = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || "Unknown error.";
    throw new Error(`OpenCode CLI is unavailable: ${details}`);
  }

  return (result.stdout || result.stderr).trim();
}

export async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.on("error", () => {
      resolve(false);
    });

    server.listen(port, HOSTNAME, () => {
      server.close((error) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  });
}

export async function choosePort(requestedPort) {
  const numeric = Number(requestedPort ?? 0);
  if (Number.isInteger(numeric) && numeric > 0) {
    const available = await isPortAvailable(numeric);
    if (!available) {
      throw new Error(`Port ${numeric} is unavailable.`);
    }
    return numeric;
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOSTNAME, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve a free port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export function buildBaseUrl(port) {
  return `http://${HOSTNAME}:${port}`;
}

export async function waitForServeReady({ baseUrl, pid, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(baseUrl)) {
      return true;
    }
    if (pid && !isPidRunning(pid)) {
      return false;
    }
    await delay(250);
  }
  return await checkHealth(baseUrl);
}

export async function runServeProbe(directory, requestedPort = 0) {
  const port = await choosePort(requestedPort);
  const baseUrl = buildBaseUrl(port);
  const env = opencodeEnv(directory);
  const logs = [];

  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", HOSTNAME, "--print-logs"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let exitCode = null;
  let spawnError = null;

  child.stdout.on("data", (chunk) => {
    logs.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    logs.push(chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("close", (code) => {
    exitCode = code;
  });

  let ok = false;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkHealth(baseUrl)) {
      ok = true;
      break;
    }
    if (spawnError || exitCode != null) {
      break;
    }
    await delay(250);
  }

  if (child.pid && isPidRunning(child.pid)) {
    await terminateProcess(child.pid);
  }

  return {
    ok,
    port,
    logs: logs.join(""),
    exitCode,
    error: spawnError
  };
}

export function normalizeState(state) {
  if (!state || typeof state !== "object") {
    return null;
  }
  const pid = Number(state.pid);
  const port = Number(state.port);
  const startedAt = typeof state.startedAt === "string" ? state.startedAt : null;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || !startedAt) {
    return null;
  }
  return { pid, port, startedAt };
}

export async function ensureManagedServe(directory, requestedPort = 0) {
  await ensureOpencodeInstalled(directory);

  const existing = normalizeState(readState(directory));
  if (existing) {
    const healthy = await checkHealth(buildBaseUrl(existing.port));
    if (healthy && isPidRunning(existing.pid)) {
      return { ...existing, reused: true };
    }

    if (isPidRunning(existing.pid)) {
      log(`Found stale managed OpenCode serve process ${existing.pid}; stopping it.`);
      await terminateProcess(existing.pid);
    }
    removeState(directory);
  }

  const port = await choosePort(requestedPort);
  const baseUrl = buildBaseUrl(port);
  const env = opencodeEnv(directory);
  let spawnError = null;

  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", HOSTNAME], {
    cwd: directory,
    env,
    detached: true,
    stdio: "ignore"
  });

  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const ready = await waitForServeReady({
    baseUrl,
    pid: child.pid,
    timeoutMs: STARTUP_TIMEOUT_MS
  });

  if (!ready || spawnError) {
    if (child.pid && isPidRunning(child.pid)) {
      await terminateProcess(child.pid);
    }
    const probe = await runServeProbe(directory, port);
    const detail =
      probe.error?.message ||
      firstNonEmptyLine(probe.logs) ||
      (spawnError ? spawnError.message : null) ||
      "The server did not become healthy before the startup timeout.";
    throw new Error(`Failed to start OpenCode serve. ${detail}`);
  }

  const state = {
    pid: child.pid,
    port,
    startedAt: new Date().toISOString()
  };
  writeState(directory, state);
  return { ...state, reused: false };
}
