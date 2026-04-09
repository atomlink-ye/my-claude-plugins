import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getMockOpenCodeServerRegistrySnapshot } from "../mocks/opencode-server.mjs";

const execFileAsync = promisify(execFile);

export function makeTempDir(prefix = "opencode-slave-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

export async function writeFakeOpencodeBinary(binDir, { markerFile = null } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "opencode");
  const markerLine = markerFile
    ? `printf '%s\\n' "$*" >> "${markerFile.replace(/"/g, '\\"')}"`
    : "true";
  const script = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  echo "opencode mock 1.0.0"
  exit 0
fi
if [ "\${1:-}" = "serve" ]; then
  ${markerLine}
  exit 99
fi
echo "unexpected opencode invocation: $*" >&2
exit 1
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

export async function spawnCompanion(args, { env = {}, cwd = process.cwd(), timeoutMs = 30000 } = {}) {
  const childEnv = {
    ...process.env,
    ...env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS ?? "",
      `--import=${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mocks/opencode-fetch-preload.mjs")}`
    ]
      .filter(Boolean)
      .join(" "),
    OPENCODE_MOCK_FETCH_REGISTRY: JSON.stringify(getMockOpenCodeServerRegistrySnapshot())
  };
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "opencode-companion.mjs");

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        finish({ stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(), exitCode: null });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      finish({ stdout, stderr, exitCode });
    });
  });
}

export async function runGit(args, cwd) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: process.env
  });
  return { stdout, stderr };
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100, description = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
