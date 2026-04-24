import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TEST_MODEL = process.env.OPENCODE_TEST_MODEL || "openai:gpt-5.4-mini";
const INTEGRATION_ENABLED = process.env.OPENCODE_INTEGRATION === "true";
const HOSTNAME = "127.0.0.1";
const STATE_FILE_NAME = ".opencode-serve.json";
const JOBS_FILE_NAME = ".opencode-jobs.json";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const companionScript = path.join(repoRoot, "plugins", "opencode", "scripts", "opencode-companion.mjs");
const workspaceDir = mkdtempSync(path.join(tmpdir(), "opencode-real-serve-"));
const stateFilePath = path.join(workspaceDir, STATE_FILE_NAME);
const jobsFilePath = path.join(workspaceDir, JOBS_FILE_NAME);

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }

  return result.stdout || "";
}

function setupGitWorkspace(directory) {
  writeFileSync(
    path.join(directory, ".gitignore"),
    [
      ".opencode-state/",
      ".opencode-serve.json",
      ".opencode-jobs.json",
      ".opencode-job-*.log"
    ].join("\n") + "\n",
    "utf8"
  );
  writeFileSync(path.join(directory, "README.md"), "opencode integration workspace\n", "utf8");

  runGit(["init", "-q"], directory);
  runGit(["config", "user.name", "Codex"], directory);
  runGit(["config", "user.email", "codex@example.com"], directory);
  runGit(["add", ".gitignore", "README.md"], directory);
  runGit(["commit", "-q", "-m", "initial commit"], directory);
}

function spawnCompanion(args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    timeoutMs = 15_000
  } = options;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [companionScript, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let timedOut = false;
    let settled = false;
    let timeoutHandle = null;
    let killHandle = null;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (killHandle) {
        clearTimeout(killHandle);
      }
      resolve({
        ...result,
        exitCode,
        exitSignal,
        pid: child.pid,
        stdout,
        stderr
      });
    };

    if (timeoutMs != null) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore timeout shutdown failures.
        }

        killHandle = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore hard-kill failures too.
          }
        }, 5_000);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ error, timedOut: false });
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish({ error: null, timedOut });
    });
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return await predicate();
}

async function fetchHealth(port) {
  const response = await fetch(`http://${HOSTNAME}:${port}/global/health`, {
    headers: { accept: "application/json" }
  });
  const body = await response.json();
  return { response, body };
}

function extractPrimaryOutput(stdout) {
  const marker = "\n--- OpenCode Result ---";
  const index = stdout.indexOf(marker);
  return (index === -1 ? stdout : stdout.slice(0, index)).trim();
}

function extractJobId(stdout) {
  const match = stdout.match(/\b(task-[a-f0-9]{6}-[a-f0-9]{6})\b/i);
  if (!match) {
    throw new Error(`Unable to extract job id from output:\n${stdout}`);
  }
  return match[1];
}

function formatCommandFailure(label, result) {
  return [
    `${label} failed`,
    `exitCode: ${String(result.exitCode)}`,
    `timedOut: ${String(result.timedOut)}`,
    `stdout:\n${result.stdout.trimEnd() || "<empty>"}`,
    `stderr:\n${result.stderr.trimEnd() || "<empty>"}`
  ].join("\n");
}

async function runAndAssertSuccessful(label, args, options = {}) {
  const startedAt = Date.now();
  const result = await spawnCompanion(args, options);
  const elapsedMs = Date.now() - startedAt;
  if (result.error || result.timedOut || result.exitCode !== 0) {
    throw new Error(formatCommandFailure(label, result));
  }
  return { ...result, elapsedMs };
}

let suiteReady = false;

try {
  execSync("which opencode");
  if (!INTEGRATION_ENABLED) {
    suiteReady = false;
  } else {
    setupGitWorkspace(workspaceDir);
    const probe = await spawnCompanion(["serve", "status", "--server-directory", workspaceDir], {
      timeoutMs: 25_000
    });

    if (probe.error || probe.timedOut || probe.exitCode !== 0) {
      suiteReady = false;
    } else {
      suiteReady = true;
    }
  }
} catch {
  suiteReady = false;
}

if (!suiteReady) {
  rmSync(workspaceDir, { force: true, recursive: true });
}

const describeMaybe = describe.skipIf(!suiteReady);

describeMaybe("real opencode serve lifecycle", () => {
  let serveState = null;

  beforeAll(async () => {
    const result = await runAndAssertSuccessful(
      "serve start",
      ["serve", "start", "--server-directory", workspaceDir],
      { timeoutMs: 25_000 }
    );

    expect(result.stdout).toContain(workspaceDir);
    expect(existsSync(stateFilePath)).toBe(true);
    serveState = readJson(stateFilePath);
  });

  afterAll(async () => {
    try {
      await spawnCompanion(["serve", "stop", "--server-directory", workspaceDir], {
        timeoutMs: 20_000
      });
    } finally {
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });

  test(
    "ensure-serve starts a real opencode serve process",
    async () => {
      expect(serveState).not.toBeNull();
      expect(typeof serveState.startedAt).toBe("string");
      expect(Number.isInteger(serveState.port)).toBe(true);
      expect(serveState.port).toBeGreaterThan(0);
      expect(Number.isInteger(serveState.pid)).toBe(true);
      expect(serveState.pid).toBeGreaterThan(0);
      expect(existsSync(stateFilePath)).toBe(true);

      const health = await fetchHealth(serveState.port);
      expect(health.response.ok).toBe(true);
      expect(health.body).toEqual({ healthy: true });
      expect(isPidRunning(serveState.pid)).toBe(true);
    },
    15_000
  );

  test(
    "job list / serve status surface shows the running serve",
    async () => {
      const result = await runAndAssertSuccessful(
        "serve status",
        ["serve", "status", "--server-directory", workspaceDir],
        { timeoutMs: 15_000 }
      );

      expect(result.stdout).toContain(String(serveState.port));
      expect(result.stdout).toContain("health");
      expect(result.stdout).toContain("managed pid");
    },
    15_000
  );

  test(
    `session new --model ${TEST_MODEL} (foreground)`,
    async () => {
      const startedAt = Date.now();
      const result = await spawnCompanion(
        [
          "session",
          "new",
          "--directory",
          workspaceDir,
          "--model",
          TEST_MODEL,
          "--",
          "respond with exactly: integration-test-pass"
        ],
        { timeoutMs: 80_000 }
      );
      const elapsedMs = Date.now() - startedAt;

      if (result.error || result.timedOut || result.exitCode !== 0) {
        throw new Error(formatCommandFailure("foreground task", result));
      }

      expect(elapsedMs).toBeLessThan(60_000);
      expect(extractPrimaryOutput(result.stdout)).not.toHaveLength(0);
    },
    90_000
  );

  test(
    `session new --background --model ${TEST_MODEL}`,
    async () => {
      const start = await runAndAssertSuccessful(
        "background task start",
        [
          "session",
          "new",
          "--directory",
          workspaceDir,
          "--background",
          "--model",
          TEST_MODEL,
          "--",
          "respond with exactly: bg-test-ok"
        ],
        { timeoutMs: 15_000 }
      );
      const jobId = extractJobId(start.stdout);

      let statusOutput = "";
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await runAndAssertSuccessful(
          `job status ${jobId}`,
          ["job", "status", jobId, "--directory", workspaceDir],
          { timeoutMs: 10_000 }
        );
        statusOutput = status.stdout;
        if (/completed/i.test(statusOutput)) {
          break;
        }
        await sleep(2_000);
      }

      expect(statusOutput).toMatch(/completed/i);

      const jobs = readJson(jobsFilePath);
      const jobRecord = jobs.find((job) => job.id === jobId);
      expect(jobRecord).toBeDefined();
      expect(jobRecord.status).toBe("completed");

      const result = await runAndAssertSuccessful(
        `job result ${jobId}`,
        ["job", "result", jobId, "--directory", workspaceDir],
        { timeoutMs: 15_000 }
      );
      expect(result.stdout.trim()).not.toHaveLength(0);
    },
    90_000
  );

  test(
    "cancel a background task",
    async () => {
      const start = await runAndAssertSuccessful(
        "cancel target start",
        [
          "session",
          "new",
          "--directory",
          workspaceDir,
          "--background",
          "--model",
          TEST_MODEL,
          "--",
          "write a long, careful explanation of the tradeoffs between consensus protocols, then stop before finishing"
        ],
        { timeoutMs: 15_000 }
      );
      const jobId = extractJobId(start.stdout);

      const cancel = await runAndAssertSuccessful(
        `job cancel ${jobId}`,
        ["job", "cancel", jobId, "--directory", workspaceDir],
        { timeoutMs: 15_000 }
      );
      expect(cancel.stdout).toContain(`Cancelled background job ${jobId}.`);

      let statusOutput = "";
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await runAndAssertSuccessful(
          `job status ${jobId}`,
          ["job", "status", jobId, "--directory", workspaceDir],
          { timeoutMs: 10_000 }
        );
        statusOutput = status.stdout;
        if (/cancelled|failed/i.test(statusOutput)) {
          break;
        }
        await sleep(2_000);
      }

      expect(statusOutput).toMatch(/cancelled|failed/i);

      const jobs = readJson(jobsFilePath);
      const jobRecord = jobs.find((job) => job.id === jobId);
      expect(jobRecord).toBeDefined();
      expect(["cancelled", "failed"]).toContain(jobRecord.status);
    },
    90_000
  );

  test(
    `review (working-tree)`,
    async () => {
      writeFileSync(path.join(workspaceDir, "review-target.txt"), "dirty working tree for review\n", "utf8");

      const startedAt = Date.now();
      const result = await spawnCompanion(
        [
          "review",
          "--scope",
          "working-tree",
          "--model",
          TEST_MODEL,
          "--directory",
          workspaceDir
        ],
        { timeoutMs: 80_000 }
      );
      const elapsedMs = Date.now() - startedAt;

      if (result.error || result.timedOut || result.exitCode !== 0) {
        throw new Error(formatCommandFailure("working-tree review", result));
      }

      expect(elapsedMs).toBeLessThan(60_000);
      expect(extractPrimaryOutput(result.stdout)).not.toHaveLength(0);
    },
    90_000
  );

  test(
    "cleanup stops the serve",
    async () => {
      const cleanup = await runAndAssertSuccessful(
        "serve stop",
        ["serve", "stop", "--server-directory", workspaceDir],
        { timeoutMs: 20_000 }
      );

      expect(cleanup.stdout).toContain(`Stopped managed OpenCode serve for ${workspaceDir}`);
      expect(existsSync(stateFilePath)).toBe(false);
      expect(await waitFor(() => !isPidRunning(serveState.pid), { timeoutMs: 15_000, intervalMs: 250 })).toBe(true);
    },
    15_000
  );
});
