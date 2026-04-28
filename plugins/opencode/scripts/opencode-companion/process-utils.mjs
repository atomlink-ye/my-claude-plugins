import { spawn } from "node:child_process";
import process from "node:process";

import { SHUTDOWN_TIMEOUT_MS } from "./constants.mjs";

export function stderr(message) {
  process.stderr.write(`${message}\n`);
}

export function log(message) {
  stderr(`[opencode] ${message}`);
}

export async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isPidRunning(pid);
}

export async function terminateProcess(pid) {
  if (!isPidRunning(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isPidRunning(pid)) {
      return false;
    }
    throw error;
  }

  if (await waitForPidExit(pid, SHUTDOWN_TIMEOUT_MS)) {
    return true;
  }

  process.kill(pid, "SIGKILL");
  await waitForPidExit(pid, 1000);
  return true;
}

export async function runCommandCapture(command, args, { cwd, env, timeoutMs = 5000 } = {}) {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderrText = "";
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finalize = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore timeouts during forced shutdown.
        }
        finalize({ exitCode: null, stdout, stderr: stderrText, timedOut: true, error: null });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderrText += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finalize({ exitCode: null, stdout, stderr: stderrText, timedOut: false, error });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      finalize({ exitCode, stdout, stderr: stderrText, timedOut: false, error: null });
    });
  });
}
