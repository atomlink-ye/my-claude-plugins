#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOSTNAME = "127.0.0.1";
const STATE_FILE_NAME = ".opencode-serve.json";
const JOBS_FILE_NAME = ".opencode-jobs.json";
const JOB_LOG_PREFIX = ".opencode-job-";
const JOB_LOG_SUFFIX = ".log";
const RUNTIME_STATE_DIR_NAME = ".opencode-state";
const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_TIMEOUT_MS = 1200;
const SHUTDOWN_TIMEOUT_MS = 5000;
const MESSAGE_POST_TIMEOUT_MS = 3600000;
const STATUS_SESSION_LIMIT = 10;
const MAX_STORED_JOBS = 50;
const STATUS_RECENT_LIMIT = 5;
const STATUS_LOG_TAIL_LINES = 5;
const DEFAULT_SESSION_TIMEOUT_MINS = 60;

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/opencode-companion.mjs serve start [--port N] [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs serve status [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs serve stop [--server-directory SERVER_DIR]",
      "",
      "  node scripts/opencode-companion.mjs session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] -- \"PROMPT\"",
      "  node scripts/opencode-companion.mjs session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] -- \"PROMPT\"",
      "  node scripts/opencode-companion.mjs session attach <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]",
      "  node scripts/opencode-companion.mjs session wait <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]",
      "  node scripts/opencode-companion.mjs session list [--directory WORK_DIR] [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs session status <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]",
      "",
      "  node scripts/opencode-companion.mjs job list [--directory WORK_DIR] [--server-directory SERVER_DIR] [--all]",
      "  node scripts/opencode-companion.mjs job status <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs job wait <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]",
      "  node scripts/opencode-companion.mjs job result <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs job cancel <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]",
      "",
      `  Default session timeout: ${DEFAULT_SESSION_TIMEOUT_MINS} minutes`,
      "  SERVER_DIR: where .opencode-serve.json lives (default: ~)",
      "  WORK_DIR:   project working directory sent to OpenCode sessions (default: $CLAUDE_PROJECT_DIR or cwd)"
    ].join("\n") + "\n"
  );
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function log(message) {
  stderr(`[opencode] ${message}`);
}

function readEnvDurationMs(name, fallbackMs) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return fallbackMs;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseArgs(argv, { booleanFlags = [], stringFlags = [] } = {}) {
  const booleans = new Set(booleanFlags);
  const strings = new Set(stringFlags);
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (booleans.has(token)) {
      options[token.slice(2)] = true;
      continue;
    }

    if (!strings.has(token)) {
      throw new Error(`Unknown option: ${token}`);
    }

    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      throw new Error(`Missing value for option: ${token}`);
    }
    options[token.slice(2)] = next;
    index += 1;
  }

  return { options, positionals };
}

function resolveValidDirectory(resolved) {
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

// Server directory: where .opencode-serve.json lives. Defaults to home (~).
function resolveServerDirectory(input) {
  return resolveValidDirectory(path.resolve(input ?? os.homedir()));
}

// Working directory: the project context sent to OpenCode sessions.
function resolveDirectory(input) {
  return resolveValidDirectory(path.resolve(input ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
}

function stateFilePath(directory) {
  return path.join(directory, STATE_FILE_NAME);
}

function runtimeStateDirectory(directory) {
  return path.join(directory, RUNTIME_STATE_DIR_NAME);
}

function readState(directory) {
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

function writeState(directory, state) {
  fs.writeFileSync(stateFilePath(directory), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState(directory) {
  fs.rmSync(stateFilePath(directory), { force: true });
}

function isPidRunning(pid) {
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

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isPidRunning(pid);
}

async function terminateProcess(pid) {
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

function opencodeEnv(directory) {
  const stateRoot = runtimeStateDirectory(directory);
  fs.mkdirSync(stateRoot, { recursive: true });
  return {
    ...process.env,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME || stateRoot
  };
}

async function runCommandCapture(command, args, { cwd, env, timeoutMs = 5000 } = {}) {
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

async function runGitCommand(directory, args, { timeoutMs = 10000, allowNonZero = false } = {}) {
  const result = await runCommandCapture("git", args, {
    cwd: directory,
    env: opencodeEnv(directory),
    timeoutMs
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("Git is not installed or is not on PATH.");
  }

  if (result.timedOut) {
    throw new Error(`Timed out while running git ${args.join(" ")}.`);
  }

  if (!allowNonZero && result.exitCode !== 0) {
    const details = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || "Unknown error.";
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }

  return result;
}

async function ensureOpencodeInstalled(directory) {
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

async function isPortAvailable(port) {
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

async function choosePort(requestedPort) {
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

function buildBaseUrl(port) {
  return `http://${HOSTNAME}:${port}`;
}

function nowIso() {
  return new Date().toISOString();
}

function randomSix() {
  return crypto.randomBytes(3).toString("hex");
}

function generateJobId() {
  return `task-${randomSix()}-${randomSix()}`;
}

function jobsFilePath(directory) {
  return path.join(directory, JOBS_FILE_NAME);
}

function jobLogFilePath(directory, jobId) {
  return path.join(directory, `${JOB_LOG_PREFIX}${jobId}${JOB_LOG_SUFFIX}`);
}

function ensureDirectoryExists(directory) {
  const stats = fs.statSync(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
}

function safeReadJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${path.basename(filePath)}: ${error.message}`);
  }
}

function normalizeJobsValue(value) {
  if (Array.isArray(value)) {
    return value.filter((job) => job && typeof job === "object" && !Array.isArray(job));
  }
  if (value && typeof value === "object" && Array.isArray(value.jobs)) {
    return value.jobs.filter((job) => job && typeof job === "object" && !Array.isArray(job));
  }
  return [];
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? right.completedAt ?? right.startedAt ?? "").localeCompare(
      String(left.updatedAt ?? left.completedAt ?? left.startedAt ?? "")
    )
  );
}

function pruneOldJobs(jobs) {
  return sortJobsNewestFirst(jobs).slice(0, MAX_STORED_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function readJobs(directory) {
  ensureDirectoryExists(directory);
  return normalizeJobsValue(safeReadJsonFile(jobsFilePath(directory), []));
}

function writeJobs(directory, jobs) {
  ensureDirectoryExists(directory);
  const previousJobs = readJobs(directory);
  const nextJobs = pruneOldJobs(jobs);
  const nextJobIds = new Set(nextJobs.map((job) => job.id));

  for (const job of previousJobs) {
    if (!nextJobIds.has(job.id)) {
      removeFileIfExists(job.logFile);
    }
  }

  fs.writeFileSync(jobsFilePath(directory), `${JSON.stringify(nextJobs, null, 2)}\n`, "utf8");
  return nextJobs;
}

function upsertJob(directory, patch) {
  const jobs = readJobs(directory);
  const now = nowIso();
  const existingIndex = jobs.findIndex((job) => job.id === patch.id);
  const nextRecord =
    existingIndex === -1
      ? {
          createdAt: now,
          updatedAt: now,
          ...patch
        }
      : {
          ...jobs[existingIndex],
          ...patch,
          updatedAt: now
        };

  if (existingIndex === -1) {
    jobs.unshift(nextRecord);
  } else {
    jobs[existingIndex] = nextRecord;
  }

  writeJobs(directory, jobs);
  return nextRecord;
}

function readJob(directory, jobId) {
  return readJobs(directory).find((job) => job.id === jobId) ?? null;
}

function isActiveJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

function refreshStaleRunningJobs(directory) {
  const jobs = readJobs(directory);
  let changed = false;
  const completedAt = nowIso();
  const staleQueuedMs = 30_000;
  const nowMs = Date.now();

  const nextJobs = jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }

    if (job.status === "running") {
      if (!Number.isInteger(job.pid) || job.pid <= 0 || isPidRunning(job.pid)) {
        return job;
      }

      changed = true;
      return {
        ...job,
        status: "failed",
        completedAt,
        pid: null,
        error: "Worker process died unexpectedly",
        updatedAt: completedAt
      };
    }

    const hasPid = Number.isInteger(job.pid) && job.pid > 0;
    if (hasPid) {
      if (isPidRunning(job.pid)) {
        return job;
      }

      changed = true;
      return {
        ...job,
        status: "failed",
        completedAt,
        pid: null,
        error: "Worker process died unexpectedly",
        updatedAt: completedAt
      };
    }

    const startedAtMs = Date.parse(job.startedAt ?? "");
    if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs <= staleQueuedMs) {
      return job;
    }

    changed = true;
    return {
      ...job,
      status: "failed",
      completedAt,
      pid: null,
      error: "Worker process died unexpectedly",
      updatedAt: completedAt
    };
  });

  if (changed) {
    writeJobs(directory, nextJobs);
    return nextJobs;
  }

  return jobs;
}

function formatDuration(startIso, endIso = nowIso()) {
  const start = Date.parse(startIso ?? "");
  const end = Date.parse(endIso ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function summarizePrompt(prompt) {
  const normalized = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 120)}...`;
}

function normalizePromptText(prompt) {
  return String(prompt ?? "").trim();
}

async function gitText(directory, args, options = {}) {
  const result = await runGitCommand(directory, args, options);
  return String(result.stdout ?? "").trimEnd();
}

async function resolveDefaultReviewBaseRef(directory) {
  const upstream = await gitText(directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowNonZero: true
  });
  if (upstream) {
    return upstream;
  }

  const originHead = await gitText(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    allowNonZero: true
  });
  if (originHead) {
    return originHead;
  }

  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    const exists = await gitText(directory, ["rev-parse", "--verify", "--quiet", candidate], {
      allowNonZero: true
    });
    if (exists) {
      return candidate;
    }
  }

  return null;
}

async function getCurrentGitBranch(directory) {
  const branch = await gitText(directory, ["branch", "--show-current"], {
    allowNonZero: true
  });
  return branch || null;
}

async function getAheadCommitCount(directory, baseRef) {
  const count = await gitText(directory, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const parsed = Number(count);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReviewScope(scope) {
  const value = String(scope ?? "auto").trim();
  if (!value) {
    return "auto";
  }
  if (value === "auto" || value === "working-tree" || value === "branch") {
    return value;
  }
  throw new Error(`Invalid review scope: ${scope}. Use auto, working-tree, or branch.`);
}

async function collectWorkingTreeReviewContext(directory) {
  const status = await gitText(directory, ["status", "--short", "--untracked-files=all"]);
  const staged = await gitText(directory, ["diff", "--cached", "--no-ext-diff", "--unified=3"]);
  const unstaged = await gitText(directory, ["diff", "--no-ext-diff", "--unified=3"]);

  if (!status.trim() && !staged.trim() && !unstaged.trim()) {
    throw new Error("No staged or unstaged changes found for working-tree review.");
  }

  const sections = [
    "Review scope: working-tree",
    `Directory: ${directory}`
  ];

  if (status.trim()) {
    sections.push("", "Git status:", status.trimEnd());
  }

  sections.push("", "Staged diff:", staged.trimEnd() || "(none)", "", "Unstaged diff:", unstaged.trimEnd() || "(none)");
  return sections.join("\n");
}

async function collectBranchReviewContext(directory, baseRef) {
  const branch = await getCurrentGitBranch(directory);
  const head = await gitText(directory, ["rev-parse", "--short", "HEAD"]);
  const log = await gitText(directory, ["log", "--oneline", `${baseRef}..HEAD`]);
  const diff = await gitText(directory, ["diff", "--no-ext-diff", "--unified=3", `${baseRef}...HEAD`]);

  if (!log.trim() && !diff.trim()) {
    throw new Error(`No commits or diff found between ${baseRef} and HEAD for branch review.`);
  }

  const sections = [
    "Review scope: branch",
    `Directory: ${directory}`,
    `Branch: ${branch ?? "detached HEAD"}`,
    `Base: ${baseRef}`,
    `Head: ${head || "unknown"}`
  ];

  if (log.trim()) {
    sections.push("", `Commit log (${baseRef}..HEAD):`, log.trimEnd());
  }

  if (diff.trim()) {
    sections.push("", `Diff (${baseRef}...HEAD):`, diff.trimEnd());
  }

  return sections.join("\n");
}

function buildReviewPrompt(context, { adversarial = false, focusText = null } = {}) {
  const sections = [];

  if (adversarial) {
    sections.push(
      "You are performing an adversarial code review. Challenge design decisions, question tradeoffs, and identify assumptions."
    );
  }

  sections.push(
    "Please review the following code changes and report findings by severity (Critical/High/Medium/Low). Include file paths and line numbers."
  );

  if (focusText) {
    sections.push("", `Focus the review on: ${focusText}`);
  }

  sections.push("", context);
  return sections.join("\n");
}

function readLogText(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  return fs.readFileSync(logFile, "utf8");
}

function readLogTail(logFile, lineCount = STATUS_LOG_TAIL_LINES) {
  const text = readLogText(logFile);
  if (!text) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(-lineCount);
}

function appendLogLine(logFile, message) {
  if (!logFile || !message) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`, "utf8");
}

function appendLogChunk(logFile, chunk) {
  if (!logFile || chunk == null) {
    return;
  }
  fs.appendFileSync(logFile, chunk, "utf8");
}

function buildJobRecord(directory, jobId, prompt, options = {}) {
  const promptText = normalizePromptText(prompt);
  return {
    id: jobId,
    status: options.status ?? "queued",
    prompt: promptText,
    promptSummary: summarizePrompt(promptText),
    startedAt: options.startedAt ?? null,
    completedAt: options.completedAt ?? null,
    directory,
    model: options.model ?? null,
    pid: options.pid ?? null,
    logFile: options.logFile ?? jobLogFilePath(directory, jobId),
    sessionId: options.sessionId ?? null,
    error: options.error ?? null
  };
}

function markJobRunning(directory, jobId, patch = {}) {
  return upsertJob(directory, {
    id: jobId,
    ...patch,
    status: "running",
    startedAt: patch.startedAt ?? nowIso(),
    completedAt: null,
    error: null
  });
}

function markJobFinished(directory, jobId, status, patch = {}) {
  const current = readJob(directory, jobId);
  if (current?.status === "cancelled") {
    return current;
  }

  return upsertJob(directory, {
    id: jobId,
    ...patch,
    status,
    completedAt: patch.completedAt ?? nowIso(),
    pid: null
  });
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function formatJobStatusLine(job) {
  const parts = [job.id, job.status ?? "unknown"];
  if (job.model) {
    parts.push(job.model);
  }
  if (job.promptSummary) {
    parts.push(job.promptSummary);
  }
  return parts.join(" | ");
}

function buildJobHierarchyMetadata(job, hierarchyContext) {
  if (!job?.sessionId || !hierarchyContext?.summariesById?.has(job.sessionId)) {
    return null;
  }
  const rootSessionId = findSessionRootId(job.sessionId, hierarchyContext);
  const subtreeSummary = summarizeSessionSubtree(rootSessionId, hierarchyContext);
  return {
    rootSessionId,
    currentSessionId: job.sessionId,
    subtreeSummary,
    hierarchyVerdict: deriveHierarchyVerdict(subtreeSummary),
    currentSession: hierarchyContext.summariesById.get(job.sessionId),
    currentSessionObservedStatus: deriveObservedSessionStatus(hierarchyContext.summariesById.get(job.sessionId))
  };
}

function renderJobHierarchySection(job, hierarchyContext) {
  const metadata = buildJobHierarchyMetadata(job, hierarchyContext);
  if (!metadata) {
    return "";
  }
  return [
    "## Session Hierarchy",
    "",
    `- current session: ${metadata.currentSessionId}`,
    `- current observed status: ${metadata.currentSessionObservedStatus}`,
    `- root session: ${metadata.rootSessionId}`,
    `- hierarchy verdict: ${metadata.hierarchyVerdict}`,
    `- hierarchy size: ${metadata.subtreeSummary.sessionCount}`,
    `- descendants: ${metadata.subtreeSummary.descendantCount}`,
    `- statuses: ${formatHierarchyStatusCounts(metadata.subtreeSummary.statusCounts)}`,
    `- latest activity: ${metadata.subtreeSummary.latestActivityLabel || "-"}`,
    `- latest activity session: ${metadata.subtreeSummary.latestActivitySessionId || "-"}`,
    "",
    renderSessionHierarchyTable(hierarchyContext, metadata.rootSessionId).trimEnd()
  ].join("\n") + "\n";
}

function renderJobTable(jobs, hierarchyBySessionId = new Map()) {
  const lines = [
    "| id | job | session | root | hierarchy verdict | hierarchy | started | elapsed | model | prompt | pid |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  if (jobs.length === 0) {
    lines.push("| none | - | - | - | - | - | - | - | - | No jobs recorded yet. | - |");
    return `${lines.join("\n")}\n`;
  }

  for (const job of jobs) {
    const hierarchyMetadata = hierarchyBySessionId.get(job.sessionId) ?? null;
    lines.push(
      `| ${escapeTableCell(job.id)} | ${escapeTableCell(job.status ?? "")} | ${escapeTableCell(job.sessionId ?? "")} | ${escapeTableCell(hierarchyMetadata?.rootSessionId ?? "")} | ${escapeTableCell(hierarchyMetadata?.hierarchyVerdict ?? "")} | ${escapeTableCell(hierarchyMetadata ? `${hierarchyMetadata.subtreeSummary.sessionCount} / ${formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts)}` : "") } | ${escapeTableCell(job.startedAt ?? "")} | ${escapeTableCell(job.elapsed ?? "")} | ${escapeTableCell(job.model ?? "")} | ${escapeTableCell(job.promptSummary ?? "")} | ${escapeTableCell(job.pid ?? "")} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderJobDetails(job, hierarchyContext = null) {
  const hierarchyMetadata = buildJobHierarchyMetadata(job, hierarchyContext);
  const lines = [
    "| field | value |",
    "| --- | --- |",
    `| id | ${escapeTableCell(job.id)} |`,
    `| status | ${escapeTableCell(job.status ?? "")} |`,
    `| directory | ${escapeTableCell(job.directory ?? "")} |`,
    `| started | ${escapeTableCell(job.startedAt ?? "")} |`,
    `| elapsed | ${escapeTableCell(job.elapsed ?? "")} |`,
    `| model | ${escapeTableCell(job.model ?? "")} |`,
    `| pid | ${escapeTableCell(job.pid ?? "")} |`,
    `| sessionId | ${escapeTableCell(job.sessionId ?? "")} |`,
    `| root session | ${escapeTableCell(hierarchyMetadata?.rootSessionId ?? "")} |`,
    `| current observed session status | ${escapeTableCell(hierarchyMetadata?.currentSessionObservedStatus ?? "")} |`,
    `| hierarchy verdict | ${escapeTableCell(hierarchyMetadata?.hierarchyVerdict ?? "")} |`,
    `| hierarchy size | ${escapeTableCell(hierarchyMetadata?.subtreeSummary.sessionCount ?? "")} |`,
    `| hierarchy statuses | ${escapeTableCell(hierarchyMetadata ? formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts) : "")} |`,
    `| hierarchy latest activity | ${escapeTableCell(hierarchyMetadata?.subtreeSummary.latestActivityLabel ?? "")} |`,
    `| hierarchy latest activity session | ${escapeTableCell(hierarchyMetadata?.subtreeSummary.latestActivitySessionId ?? "")} |`,
    `| prompt | ${escapeTableCell(job.prompt ?? job.promptSummary ?? "")} |`,
    `| log file | ${escapeTableCell(job.logFile ?? "")} |`
  ];

  if (job.completedAt) {
    lines.push(`| completed | ${escapeTableCell(job.completedAt)} |`);
  }
  if (job.error) {
    lines.push(`| error | ${escapeTableCell(job.error)} |`);
  }

  return `${lines.join("\n")}\n`;
}

function renderJobTailSection(job) {
  const tail = readLogTail(job.logFile, STATUS_LOG_TAIL_LINES);
  if (tail.length === 0) {
    return "";
  }

  const lines = [`Log tail for ${job.id}:`];
  for (const line of tail) {
    lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderBackgroundTaskStart(jobId, scriptPath, directory) {
  const script = scriptPath ?? "scripts/opencode-companion.mjs";
  // Shell-safe single-quote escaping: wrap in ' and replace internal ' with '\''
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const dirFlag = directory ? ` --directory ${sq(directory)}` : "";
  return `OpenCode task started in background as ${jobId}. Check status: node ${sq(script)} job status ${jobId}${dirFlag}\n`;
}

function createJobLogFile(directory, jobId) {
  const logFile = jobLogFilePath(directory, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

function spawnBackgroundTaskWorker(directory, jobId, prompt, args = {}) {
  const scriptPath = fileURLToPath(import.meta.url);
  const childArgs = [scriptPath, "session", "new", "--job-id", jobId, "--directory", directory];

  if (args.serverDirectory) {
    childArgs.push("--server-directory", args.serverDirectory);
  }

  if (args.model) {
    childArgs.push("--model", args.model);
  }

  if (args.agent) {
    childArgs.push("--agent", args.agent);
  }

  if (args.timeout) {
    childArgs.push("--timeout", String(args.timeout));
  }

  childArgs.push("--", prompt);

  const logFile = jobLogFilePath(directory, jobId);
  const logFd = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, childArgs, {
    cwd: directory,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });

  fs.closeSync(logFd);

  return child;
}

function buildJobListView(directory, options = {}) {
  const jobs = sortJobsNewestFirst(refreshStaleRunningJobs(directory));
  const selected = options.all ? jobs : jobs.slice(0, STATUS_RECENT_LIMIT);
  const enriched = selected.map((job) => ({
    ...job,
    elapsed:
      job.status === "running" || job.status === "queued"
        ? formatDuration(job.startedAt)
        : formatDuration(job.startedAt, job.completedAt)
  }));
  const hierarchyBySessionId = new Map();
  if (options.sessionHierarchyContext) {
    for (const job of enriched) {
      if (!job.sessionId) {
        continue;
      }
      const metadata = buildJobHierarchyMetadata(job, options.sessionHierarchyContext);
      if (metadata) {
        hierarchyBySessionId.set(job.sessionId, metadata);
      }
    }
  }

  const lines = ["# OpenCode Status", "", `Directory: ${directory}`, "", renderJobTable(enriched, hierarchyBySessionId).trimEnd()];

  const runningJobs = enriched.filter((job) => isActiveJob(job));
  if (runningJobs.length > 0) {
    lines.push("", "Running jobs:");
    for (const job of runningJobs) {
      lines.push(`- ${formatJobStatusLine(job)}`);
      const hierarchyMetadata = hierarchyBySessionId.get(job.sessionId) ?? null;
      if (hierarchyMetadata) {
        lines.push(`  Hierarchy: root ${hierarchyMetadata.rootSessionId} | verdict ${hierarchyMetadata.hierarchyVerdict} | sessions ${hierarchyMetadata.subtreeSummary.sessionCount} | ${formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts)} | latest ${hierarchyMetadata.subtreeSummary.latestActivityLabel || "-"} @ ${hierarchyMetadata.subtreeSummary.latestActivitySessionId || "-"}`);
      }
      const tail = readLogTail(job.logFile, STATUS_LOG_TAIL_LINES);
      if (tail.length > 0) {
        lines.push("  Log tail:");
        for (const line of tail) {
          lines.push(`    ${line}`);
        }
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSingleJobView(job, sessionHierarchyContext = null) {
  const enriched = {
    ...job,
    elapsed:
      job.status === "running" || job.status === "queued"
        ? formatDuration(job.startedAt)
        : formatDuration(job.startedAt, job.completedAt)
  };
  const tail = readLogTail(job.logFile, STATUS_LOG_TAIL_LINES);
  const sections = ["# OpenCode Job Status", "", renderJobDetails(enriched, sessionHierarchyContext).trimEnd()];
  const hierarchySection = renderJobHierarchySection(enriched, sessionHierarchyContext).trimEnd();
  if (hierarchySection) {
    sections.push(hierarchySection);
  }
  if (tail.length > 0) {
    sections.push(renderJobTailSection(enriched).trimEnd());
  }
  return `${sections.filter(Boolean).join("\n\n").trimEnd()}\n`;
}

function buildScopedUrl(baseUrl, pathname, directory) {
  const url = new URL(pathname, baseUrl);
  if (directory) {
    url.searchParams.set("directory", directory);
  }
  return url;
}

function buildHeaders(directory, extra = {}) {
  const headers = new Headers(extra);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }
  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const externalSignal = options.signal;

  if ((!timeoutMs || timeoutMs <= 0) && !externalSignal) {
    return await fetch(url, options);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  let timer = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", forwardAbort);
    }
  }
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function formatUnexpectedTaskAbort(model) {
  const modelLabel = model
    ? model.providerID
      ? `configured model ${model.providerID}/${model.modelID}`
      : `configured model ${model.modelID}`
    : "default model/provider";

  return new Error(
    `OpenCode aborted the task request before it completed. The ${modelLabel} may have failed authentication or become unavailable. Refresh OpenCode credentials, or rerun with --model MODEL.`
  );
}

function parseJsonMaybe(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function firstNonEmptyLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function makeHttpError(method, url, response, bodyText) {
  const detail = firstNonEmptyLine(bodyText) || `HTTP ${response.status}`;
  return new Error(`${method} ${url.pathname} failed with ${response.status}: ${detail}`);
}

async function requestJson(baseUrl, pathname, { method = "GET", directory, body, timeoutMs, signal } = {}) {
  const url = buildScopedUrl(baseUrl, pathname, directory);
  const headers = buildHeaders(directory, {
    accept: "application/json"
  });
  let payload;
  if (body != null) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      body: payload,
      signal
    },
    timeoutMs
  );
  const text = await response.text();
  if (!response.ok) {
    throw makeHttpError(method, url, response, text);
  }
  return parseJsonMaybe(text);
}

async function openEventStream(baseUrl, directory, signal) {
  const url = buildScopedUrl(baseUrl, "/event", directory);
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(directory, {
      accept: "text/event-stream"
    }),
    signal
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw makeHttpError("GET", url, response, bodyText);
  }
  if (!response.body) {
    throw new Error("OpenCode returned no response body for the event stream endpoint.");
  }
  return response;
}

async function checkHealth(baseUrl) {
  try {
    const response = await fetchWithTimeout(new URL("/global/health", baseUrl), {
      headers: { accept: "application/json" }
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServeReady({ baseUrl, pid, timeoutMs }) {
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

async function runServeProbe(directory, requestedPort = 0) {
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

function normalizeState(state) {
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

async function ensureManagedServe(directory, requestedPort = 0) {
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

function parseModelOption(rawValue) {
  if (rawValue == null) {
    return null;
  }
  const value = String(rawValue).trim();
  if (!value) {
    return null;
  }

  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || typeof parsed.modelID !== "string" || !parsed.modelID.trim()) {
      throw new Error("Model JSON must include a non-empty modelID field.");
    }
    return parsed.providerID
      ? { providerID: String(parsed.providerID), modelID: String(parsed.modelID) }
      : { modelID: String(parsed.modelID) };
  }

  let delimiter = null;
  if (value.includes("/")) {
    delimiter = "/";
  } else if (value.includes(":")) {
    delimiter = ":";
  }

  if (delimiter) {
    const [providerID, modelID] = value.split(delimiter, 2).map((part) => part.trim());
    if (!providerID || !modelID) {
      throw new Error(`Invalid model value "${value}". Use provider/model, provider:model, or JSON.`);
    }
    return { providerID, modelID };
  }

  return { modelID: value };
}

function normalizeMessageArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.messages)) {
      return payload.messages;
    }
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
  }
  return [];
}

function looksLikePath(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return false;
  }
  return (
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.startsWith(".") ||
    /\.[a-z0-9]{1,8}$/i.test(candidate)
  );
}

function collectTextParts(value, parts = [], seen = new Set(), hintKey = "", parentType = "") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return parts;
    }
    const normalizedKey = hintKey.toLowerCase();
    const normalizedType = parentType.toLowerCase();
    const shouldInclude =
      normalizedKey === "text" ||
      normalizedKey === "delta" ||
      normalizedKey === "content" ||
      normalizedKey === "value" ||
      normalizedKey === "message" ||
      normalizedKey === "markdown" ||
      normalizedKey === "body" ||
      normalizedType.includes("text");

    if (shouldInclude && !seen.has(trimmed)) {
      parts.push(trimmed);
      seen.add(trimmed);
    }
    return parts;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextParts(entry, parts, seen, hintKey, parentType);
    }
    return parts;
  }

  if (!value || typeof value !== "object") {
    return parts;
  }

  const nextType = typeof value.type === "string" ? value.type : parentType;
  // Skip reasoning/thinking and structural parts — only extract actual text output
  if (nextType === "reasoning" || nextType === "step-start" || nextType === "step-finish") {
    return parts;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectTextParts(entry, parts, seen, key, nextType);
  }
  return parts;
}

function extractTextCandidates(value) {
  return collectTextParts(value, [], new Set());
}

function collectAssistantNodes(value, nodes = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAssistantNodes(entry, nodes);
    }
    return nodes;
  }

  if (!value || typeof value !== "object") {
    return nodes;
  }

  // OpenCode format: messages have { info: { role: "assistant" }, parts: [...] }.
  // Check info.role first so we push the full message (with parts), not the info sub-object.
  const infoRole = value.info?.role;
  if (infoRole) {
    const normalized = String(infoRole).toLowerCase();
    if (normalized.includes("assistant") || normalized === "model" || normalized === "ai") {
      nodes.push(value);
      return nodes; // Don't recurse — we want the full message, not sub-objects
    }
  }

  const roleFields = [value.role, value.author, value.sender, value.source, value.kind, value.type]
    .filter(Boolean)
    .map((entry) => String(entry).toLowerCase());

  if (roleFields.some((entry) => entry.includes("assistant") || entry === "model" || entry === "ai")) {
    nodes.push(value);
  }

  for (const entry of Object.values(value)) {
    collectAssistantNodes(entry, nodes);
  }
  return nodes;
}

function extractFileChanges(value) {
  const results = [];
  const seen = new Set();

  function visit(node) {
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    const pathValue = [
      node.path,
      node.filePath,
      node.file,
      node.target,
      node.relativePath,
      node.absolutePath
    ].find((entry) => typeof entry === "string" && looksLikePath(entry));

    if (pathValue) {
      const change = [node.change, node.status, node.operation, node.action, node.kind, node.type]
        .find((entry) => typeof entry === "string" && entry.trim())
        ?.trim();
      const summary = [node.summary, node.description, node.message, node.reason]
        .find((entry) => typeof entry === "string" && entry.trim())
        ?.trim();

      const key = `${pathValue}::${change ?? ""}::${summary ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          path: pathValue,
          ...(change ? { change } : {}),
          ...(summary ? { summary } : {})
        });
      }
    }

    for (const entry of Object.values(node)) {
      visit(entry);
    }
  }

  visit(value);
  return results;
}

function formatChangeEntry(change) {
  const detail = [change.change, change.summary].filter(Boolean).join(" - ");
  return detail ? `- ${change.path} (${detail})` : `- ${change.path}`;
}

function buildTaskResult({
  directory,
  sessionId,
  messages,
  streamedText,
  status,
  completionMode = "terminal",
  rawSessionStatus = status
}) {
  const assistantNodes = collectAssistantNodes(messages);
  const preferredNode = assistantNodes.at(-1) ?? normalizeMessageArray(messages).at(-1) ?? messages;
  const textParts = extractTextCandidates(preferredNode);
  const combinedText = textParts.join("\n\n").trim() || String(streamedText ?? "").trim();
  const fileChanges = extractFileChanges(messages);

  return {
    session_id: String(sessionId),
    directory,
    status,
    completion_mode: completionMode,
    raw_session_status: normalizeSessionStatus(rawSessionStatus),
    text_parts: textParts,
    combined_text: combinedText,
    file_changes: fileChanges,
    message_count: normalizeMessageArray(messages).length,
    messages: normalizeMessageArray(messages)
  };
}

function renderTaskSummary(result) {
  const lines = [
    "",
    "",
    "--- OpenCode Result ---",
    `Session ID: ${result.session_id}`,
    `Directory: ${result.directory}`,
    `Status: ${result.status}`
  ];

  if (result.completion_mode && result.completion_mode !== "terminal") {
    lines.push(`Wrapper completion: ${result.completion_mode}`);
  }
  if (result.raw_session_status && result.raw_session_status !== result.status) {
    lines.push(`Root session raw status: ${result.raw_session_status}`);
  }

  if (result.completion_mode === "delegated_settled") {
    lines.push(
      "Note: Delegation to subagents is normal. The wrapper settled after delegated activity; wait and re-check if you need final completion.",
      "Recommended next steps:",
      `- session status ${result.session_id}`,
      `- session attach ${result.session_id}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderEnsureServeResult(directory, state) {
  const mode = state.reused ? "reused existing" : "started new";
  return `OpenCode serve ${mode} process on ${buildBaseUrl(state.port)} for ${directory} (pid ${state.pid}).\n`;
}

function renderCleanupResult(directory, details) {
  if (!details.found) {
    return `No managed OpenCode serve state found for ${directory}.\n`;
  }
  if (details.wasRunning) {
    return `Stopped managed OpenCode serve for ${directory} (pid ${details.pid}, port ${details.port}).\n`;
  }
  return `Removed stale OpenCode serve state for ${directory} (pid ${details.pid}, port ${details.port}).\n`;
}

function renderCheckResult({ directory, version, managedState, healthy, pidRunning }) {
  return [
    "OpenCode companion check passed.",
    `Directory: ${directory}`,
    `OpenCode version: ${version}`,
    `Managed serve state file: ${stateFilePath(directory)}`,
    `Managed serve pid: ${managedState?.pid ?? "none"}`,
    `Managed serve pid running: ${pidRunning ? "yes" : "no"}`,
    `Managed serve port: ${managedState?.port ?? "none"}`,
    `Managed serve health: ${healthy ? "healthy" : "not reachable"}`
  ].join("\n") + "\n";
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function parseSessionTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeSession(session) {
  const summary =
    session.title ||
    session.summary ||
    session.name ||
    extractTextCandidates(session).find(Boolean) ||
    "";
  const status =
    session.status ||
    session.state ||
    (session.running ? "running" : null) ||
    (session.active ? "active" : null) ||
    "unknown";
  const parentId = session.parentID || session.parentId || session.parent_id || "";
  const createdAt = session.createdAt || session.created_at || session.startedAt || session.time?.created || "";
  const updatedAt = session.updatedAt || session.updated_at || session.modifiedAt || session.time?.updated || "";

  return {
    id: session.id || session.sessionID || session.sessionId || "unknown",
    parentId: String(parentId || ""),
    status: String(status),
    createdAt: String(createdAt || ""),
    createdAtMs: parseSessionTimestamp(createdAt),
    updatedAt: String(updatedAt || ""),
    updatedAtMs: parseSessionTimestamp(updatedAt),
    summary: String(summary || "")
  };
}

function renderStatus(directory, state, healthy, sessions, sessionError) {
  const lines = [
    "| field | value |",
    "| --- | --- |",
    `| directory | ${escapeMarkdownCell(directory)} |`,
    `| managed state file | ${escapeMarkdownCell(stateFilePath(directory))} |`,
    `| managed pid | ${escapeMarkdownCell(state?.pid ?? "none")} |`,
    `| port | ${escapeMarkdownCell(state?.port ?? "none")} |`,
    `| started at | ${escapeMarkdownCell(state?.startedAt ?? "none")} |`,
    `| health | ${escapeMarkdownCell(healthy ? "healthy" : "not reachable")} |`
  ];

  lines.push("", "Recent sessions", "", "| id | status | created | updated | summary |", "| --- | --- | --- | --- | --- |");

  if (sessionError) {
    lines.push(`| unavailable | error |  |  | ${escapeMarkdownCell(sessionError)} |`);
  } else if (!sessions || sessions.length === 0) {
    lines.push("| none | - | - | - | No sessions reported by the server. |");
  } else {
    for (const session of sessions.slice(0, STATUS_SESSION_LIMIT).map(summarizeSession)) {
      lines.push(
        `| ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(session.createdAt)} | ${escapeMarkdownCell(session.updatedAt)} | ${escapeMarkdownCell(session.summary)} |`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderSessionTable(sessions) {
  const hierarchyContext = buildSessionHierarchyContext(sessions);
  const lines = [
    "| tree | id | parent | raw | observed | created | updated | summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  if (!sessions || sessions.length === 0) {
    lines.push("| none | - | - | - | - | - | - | No sessions reported by the server. |");
    return `${lines.join("\n")}\n`;
  }

  const appendRows = (sessionId, depth = 0) => {
    const session = hierarchyContext.summariesById.get(sessionId);
    if (!session) {
      return;
    }
    const treeLabel = depth === 0 ? "root" : `${"↳ ".repeat(depth).trim()} child`;
    const observedStatus = depth === 0
      ? deriveHierarchyVerdict(summarizeSessionSubtree(sessionId, hierarchyContext))
      : deriveObservedSessionStatus(session);
    lines.push(
      `| ${escapeMarkdownCell(treeLabel)} | ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.parentId || "-")} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(observedStatus)} | ${escapeMarkdownCell(session.createdAt)} | ${escapeMarkdownCell(session.updatedAt)} | ${escapeMarkdownCell(session.summary)} |`
    );
    for (const childId of hierarchyContext.childrenByParent.get(sessionId) ?? []) {
      appendRows(childId, depth + 1);
    }
  };

  for (const rootId of hierarchyContext.rootIds) {
    appendRows(rootId, 0);
  }

  return `${lines.join("\n")}\n`;
}

function renderSessionDetails(session, directory, hierarchyContext = null) {
  const details = summarizeSession(session);
  const effectiveHierarchyContext = hierarchyContext ?? buildSessionHierarchyContext([session]);
  const rootSessionId = findSessionRootId(details.id, effectiveHierarchyContext);
  const ancestorIds = collectAncestorIds(details.id, effectiveHierarchyContext);
  const directChildren = effectiveHierarchyContext.childrenByParent.get(details.id) ?? [];
  const descendants = collectDescendantIds(details.id, effectiveHierarchyContext);
  const subtreeSummary = summarizeSessionSubtree(rootSessionId, effectiveHierarchyContext);
  const rawVerdict = deriveSessionLifecycleVerdict(details.status);
  const observedStatus = deriveObservedSessionStatus(details);
  const sessionRecency = deriveActivityRecency(latestKnownSessionActivityAt(details, null));
  const hierarchyVerdict = deriveHierarchyVerdict(subtreeSummary);
  const nextAction = recommendHierarchyAction(hierarchyVerdict, details.id);
  const lines = [
    "| field | value |",
    "| --- | --- |",
    `| directory | ${escapeMarkdownCell(directory)} |`,
    `| id | ${escapeMarkdownCell(details.id)} |`,
    `| root session | ${escapeMarkdownCell(rootSessionId)} |`,
    `| parent | ${escapeMarkdownCell(details.parentId || "-")} |`,
    `| ancestors | ${escapeMarkdownCell(ancestorIds.join(" -> ") || "-")} |`,
    `| direct children | ${escapeMarkdownCell(directChildren.join(", ") || "-")} |`,
    `| descendant count | ${escapeMarkdownCell(descendants.length)} |`,
    `| raw status | ${escapeMarkdownCell(details.status)} |`,
    `| raw lifecycle verdict | ${escapeMarkdownCell(rawVerdict)} |`,
    `| observed session status | ${escapeMarkdownCell(observedStatus)} |`,
    `| session activity recency | ${escapeMarkdownCell(sessionRecency)} |`,
    `| hierarchy verdict | ${escapeMarkdownCell(hierarchyVerdict)} |`,
    `| recommended next action | ${escapeMarkdownCell(nextAction)} |`,
    `| created | ${escapeMarkdownCell(details.createdAt)} |`,
    `| updated | ${escapeMarkdownCell(details.updatedAt)} |`,
    `| hierarchy size | ${escapeMarkdownCell(subtreeSummary.sessionCount)} |`,
    `| hierarchy statuses | ${escapeMarkdownCell(formatHierarchyStatusCounts(subtreeSummary.statusCounts))} |`,
    `| hierarchy latest activity | ${escapeMarkdownCell(subtreeSummary.latestActivityLabel || "-")} |`,
    `| hierarchy latest activity session | ${escapeMarkdownCell(subtreeSummary.latestActivitySessionId || "-")} |`,
    `| summary | ${escapeMarkdownCell(details.summary)} |`
  ];
  return `${lines.join("\n")}\n`;
}

function buildSessionListView(directory, sessions) {
  const hierarchyContext = buildSessionHierarchyContext(sessions);
  const lines = ["# OpenCode Sessions", "", `Directory: ${directory}`, "", renderSessionTable(sessions).trimEnd()];
  if (hierarchyContext.rootIds.length > 0) {
    lines.push("", `Roots: ${hierarchyContext.rootIds.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildSingleSessionView(directory, session, hierarchyContext = null) {
  const effectiveHierarchyContext = hierarchyContext ?? buildSessionHierarchyContext([session]);
  const details = summarizeSession(session);
  const rootSessionId = findSessionRootId(details.id, effectiveHierarchyContext);
  return [
    "# OpenCode Session Status",
    "",
    renderSessionDetails(session, directory, effectiveHierarchyContext).trimEnd(),
    "",
    "## Session Hierarchy",
    "",
    renderSessionHierarchyTable(effectiveHierarchyContext, rootSessionId).trimEnd()
  ].join("\n") + "\n";
}

function parseSseBlock(block) {
  const normalized = block.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1).replace(/^\s/, "") : "";
    if (field === "data") {
      dataLines.push(rawValue);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { done: true, payload: "[DONE]" };
  }
  try {
    return {
      done: false,
      payload: JSON.parse(data)
    };
  } catch {
    return null;
  }
}

async function streamSseResponse(stream, onEvent, { abortSignal } = {}) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let aborted = false;

  const cancelReader = async () => {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors during shutdown.
    }
  };

  const abortListener = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      abortListener();
    } else {
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          if (event.done) {
            await cancelReader();
            return { streamClosed: true };
          }
          const result = await onEvent(event);
          if (result?.done || result?.aborted) {
            await cancelReader();
            return result?.aborted ? { aborted: true } : { streamClosed: true };
          }
        }
        if (aborted) {
          return { aborted: true };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");
    if (!aborted && buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) {
        if (event.done) {
          await cancelReader();
          return { streamClosed: true };
        }
        const result = await onEvent(event);
        if (result?.done || result?.aborted) {
          await cancelReader();
          return result?.aborted ? { aborted: true } : { streamClosed: true };
        }
      }
    }

    if (aborted) {
      return { aborted: true };
    }

    return { streamClosed: true };
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }
}

function normalizeSessionStatus(status) {
  return String(status ?? "unknown").trim().toLowerCase();
}

function deriveSessionLifecycleVerdict(status) {
  const normalized = normalizeSessionStatus(status);
  if (isBusySessionStatus(normalized)) {
    return "active";
  }
  if (isSuccessfulTerminalSessionStatus(normalized)) {
    return "reusable_or_finished";
  }
  if (isFailedTerminalSessionStatus(normalized)) {
    return "failed";
  }
  return "unknown";
}

function recommendSessionAction(sessionId, status) {
  const verdict = deriveSessionLifecycleVerdict(status);
  if (verdict === "active") {
    return `wait or session attach ${sessionId}`;
  }
  if (verdict === "reusable_or_finished") {
    return `session continue ${sessionId} or inspect artifacts`;
  }
  if (verdict === "failed") {
    return `inspect artifacts, then consider session new if reuse is no longer useful`;
  }
  return `session attach ${sessionId} to determine whether reuse is still viable`;
}

function isSuccessfulTerminalSessionStatus(status) {
  return new Set(["idle", "completed", "complete", "done"]).has(normalizeSessionStatus(status));
}

function isFailedTerminalSessionStatus(status) {
  return new Set(["aborted", "cancelled", "canceled", "failed", "error"]).has(normalizeSessionStatus(status));
}

function isTerminalSessionStatus(status) {
  return isSuccessfulTerminalSessionStatus(status) || isFailedTerminalSessionStatus(status);
}

function isBusySessionStatus(status) {
  return new Set(["busy", "active", "running", "working"]).has(normalizeSessionStatus(status));
}

function isSuccessfulResultStatus(status) {
  return new Set(["completed", "delegated"]).has(normalizeSessionStatus(status));
}

function isFailedResultStatus(status) {
  return new Set(["aborted", "cancelled", "canceled", "failed", "error"]).has(normalizeSessionStatus(status));
}

function deriveResultStatus({ terminalStatus, abortedBySignal, completionMode }) {
  if (abortedBySignal) {
    return "aborted";
  }
  if (completionMode === "delegated_settled") {
    return "delegated";
  }
  if (completionMode === "quiescence") {
    return "completed";
  }
  if (completionMode === "descendant_failed") {
    return "failed";
  }
  if (isSuccessfulTerminalSessionStatus(terminalStatus)) {
    return "completed";
  }
  return normalizeSessionStatus(terminalStatus);
}

async function getSessionSummary(baseUrl, directory, sessionId) {
  const sessions = await listSessions(baseUrl, directory);
  return sessions.map(summarizeSession).find((session) => session.id === sessionId) ?? null;
}

function collectSessionHierarchyIds(rootSessionId, sessionSummaries) {
  const childrenByParent = new Map();
  for (const session of sessionSummaries) {
    if (!session.parentId) {
      continue;
    }
    const siblings = childrenByParent.get(session.parentId) ?? [];
    siblings.push(session.id);
    childrenByParent.set(session.parentId, siblings);
  }

  const hierarchy = new Set([rootSessionId]);
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenByParent.get(current) ?? [];
    for (const childId of children) {
      if (hierarchy.has(childId)) {
        continue;
      }
      hierarchy.add(childId);
      queue.push(childId);
    }
  }
  return hierarchy;
}

function latestKnownSessionActivityAt(sessionSummary, trackedState) {
  const candidates = [
    trackedState?.lastActivityAt,
    sessionSummary?.updatedAtMs,
    sessionSummary?.createdAtMs
  ].filter((value) => Number.isFinite(value));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function buildSessionHierarchyContext(sessions) {
  const summaries = sessions.map(summarizeSession);
  const summariesById = new Map(summaries.map((session) => [session.id, session]));
  const childrenByParent = new Map();

  for (const session of summaries) {
    if (!session.parentId) {
      continue;
    }
    const children = childrenByParent.get(session.parentId) ?? [];
    children.push(session.id);
    childrenByParent.set(session.parentId, children);
  }

  const sortSessionIdsByRecentActivity = (ids) =>
    [...ids].sort((leftId, rightId) => {
      const left = summariesById.get(leftId);
      const right = summariesById.get(rightId);
      const leftActivity = latestKnownSessionActivityAt(left, null) ?? 0;
      const rightActivity = latestKnownSessionActivityAt(right, null) ?? 0;
      if (rightActivity !== leftActivity) {
        return rightActivity - leftActivity;
      }
      return leftId.localeCompare(rightId);
    });

  for (const [parentId, childIds] of childrenByParent.entries()) {
    childrenByParent.set(parentId, sortSessionIdsByRecentActivity(childIds));
  }

  const rootIds = sortSessionIdsByRecentActivity(
    summaries
      .filter((session) => !session.parentId || !summariesById.has(session.parentId))
      .map((session) => session.id)
  );

  return {
    summaries,
    summariesById,
    childrenByParent,
    rootIds
  };
}

function collectAncestorIds(sessionId, hierarchyContext) {
  const ancestors = [];
  const seen = new Set();
  let currentId = sessionId;
  while (currentId) {
    const current = hierarchyContext.summariesById.get(currentId);
    const parentId = current?.parentId || null;
    if (!parentId || seen.has(parentId)) {
      break;
    }
    ancestors.unshift(parentId);
    seen.add(parentId);
    currentId = parentId;
  }
  return ancestors;
}

function findSessionRootId(sessionId, hierarchyContext) {
  const ancestors = collectAncestorIds(sessionId, hierarchyContext);
  return ancestors[0] ?? sessionId;
}

function collectDescendantIds(sessionId, hierarchyContext) {
  const descendants = [];
  const queue = [...(hierarchyContext.childrenByParent.get(sessionId) ?? [])];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const currentId = queue.shift();
    descendants.push(currentId);
    for (const childId of hierarchyContext.childrenByParent.get(currentId) ?? []) {
      if (seen.has(childId)) {
        continue;
      }
      seen.add(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

function formatHierarchyStatusCounts(counts) {
  const orderedStatuses = ["active", "running", "working", "busy", "idle", "completed", "done", "failed", "error", "unknown"];
  const parts = [];
  const consumed = new Set();
  for (const status of orderedStatuses) {
    if (counts[status]) {
      parts.push(`${status}:${counts[status]}`);
      consumed.add(status);
    }
  }
  for (const [status, count] of Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!consumed.has(status) && count) {
      parts.push(`${status}:${count}`);
    }
  }
  return parts.join(", ") || "none";
}

const OBSERVED_ACTIVE_WINDOW_MS = 15000;
const OBSERVED_RECENT_WINDOW_MS = 60000;

function countStatuses(statusCounts, statuses) {
  return statuses.reduce((total, status) => total + (statusCounts[normalizeSessionStatus(status)] ?? 0), 0);
}

function deriveActivityRecency(latestActivityMs, now = Date.now()) {
  if (!Number.isFinite(latestActivityMs)) {
    return "unknown";
  }
  const ageMs = now - latestActivityMs;
  if (ageMs <= OBSERVED_ACTIVE_WINDOW_MS) {
    return "active_recent";
  }
  if (ageMs <= OBSERVED_RECENT_WINDOW_MS) {
    return "recently_active";
  }
  return "stale";
}

function deriveObservedSessionStatus(sessionSummary, now = Date.now()) {
  const rawStatus = normalizeSessionStatus(sessionSummary?.status || "unknown");
  if (isBusySessionStatus(rawStatus)) {
    return "active";
  }
  if (isFailedTerminalSessionStatus(rawStatus)) {
    return rawStatus;
  }
  if (isSuccessfulTerminalSessionStatus(rawStatus)) {
    return rawStatus === "idle" ? "idle" : "completed";
  }
  const recency = deriveActivityRecency(latestKnownSessionActivityAt(sessionSummary, null), now);
  if (recency === "active_recent") {
    return "active_recent";
  }
  if (recency === "recently_active") {
    return "recently_active";
  }
  return "quiet_unknown";
}

function deriveHierarchyVerdict(subtreeSummary, now = Date.now()) {
  const busyCount = countStatuses(subtreeSummary.statusCounts, ["busy", "active", "running", "working"]);
  const failedCount = countStatuses(subtreeSummary.statusCounts, ["aborted", "cancelled", "canceled", "failed", "error"]);
  const successfulCount = countStatuses(subtreeSummary.statusCounts, ["idle", "completed", "complete", "done"]);
  const unknownCount = subtreeSummary.sessionCount - busyCount - failedCount - successfulCount;
  const recency = deriveActivityRecency(subtreeSummary.latestActivityMs, now);

  if (busyCount > 0 || recency === "active_recent") {
    return subtreeSummary.descendantCount > 0 ? "active_descendants" : "active";
  }
  if (failedCount > 0 && recency !== "stale") {
    return "failed_with_recent_activity";
  }
  if (failedCount > 0) {
    return "failed";
  }
  if (successfulCount === subtreeSummary.sessionCount && subtreeSummary.sessionCount > 0) {
    return subtreeSummary.descendantCount > 0 ? "completed_tree" : "completed";
  }
  if (subtreeSummary.descendantCount > 0 && recency === "recently_active") {
    return "settling_descendants";
  }
  if (recency === "recently_active") {
    return "recently_active";
  }
  if (subtreeSummary.descendantCount > 0 && unknownCount === subtreeSummary.sessionCount) {
    return "quiet_tree_unknown";
  }
  return "quiet_unknown";
}

function recommendHierarchyAction(verdict, sessionId) {
  if (["active", "active_descendants", "recently_active", "settling_descendants", "failed_with_recent_activity"].includes(verdict)) {
    return `wait or session attach ${sessionId}`;
  }
  if (["completed", "completed_tree"].includes(verdict)) {
    return `inspect artifacts or session continue ${sessionId}`;
  }
  if (verdict === "failed") {
    return `inspect artifacts/logs, then decide whether to resume or start a fresh session`;
  }
  return `inspect hierarchy/logs before deciding whether to resume`;
}

function summarizeSessionSubtree(rootSessionId, hierarchyContext) {
  const subtreeSessionIds = [rootSessionId, ...collectDescendantIds(rootSessionId, hierarchyContext)].filter((id) =>
    hierarchyContext.summariesById.has(id)
  );
  const statusCounts = {};
  let latestActivityMs = null;
  let latestActivityLabel = "";
  let latestActivitySessionId = null;

  for (const sessionId of subtreeSessionIds) {
    const session = hierarchyContext.summariesById.get(sessionId);
    const normalizedStatus = normalizeSessionStatus(session?.status || "unknown");
    statusCounts[normalizedStatus] = (statusCounts[normalizedStatus] ?? 0) + 1;
    const activityMs = latestKnownSessionActivityAt(session, null);
    if (Number.isFinite(activityMs) && (latestActivityMs == null || activityMs > latestActivityMs)) {
      latestActivityMs = activityMs;
      latestActivityLabel = session?.updatedAt || session?.createdAt || "";
      latestActivitySessionId = sessionId;
    }
  }

  return {
    rootSessionId,
    subtreeSessionIds,
    sessionCount: subtreeSessionIds.length,
    descendantCount: Math.max(0, subtreeSessionIds.length - 1),
    directChildCount: (hierarchyContext.childrenByParent.get(rootSessionId) ?? []).length,
    statusCounts,
    latestActivityMs,
    latestActivityLabel,
    latestActivitySessionId
  };
}

function renderSessionHierarchyTable(hierarchyContext, rootSessionId) {
  const lines = [
    "| tree | id | parent | raw | observed | updated | summary |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];

  const appendRows = (sessionId, depth = 0) => {
    const session = hierarchyContext.summariesById.get(sessionId);
    if (!session) {
      return;
    }
    const treeLabel = depth === 0 ? "root" : `${"↳ ".repeat(depth).trim()} child`;
    const observedStatus = depth === 0
      ? deriveHierarchyVerdict(summarizeSessionSubtree(sessionId, hierarchyContext))
      : deriveObservedSessionStatus(session);
    lines.push(
      `| ${escapeMarkdownCell(treeLabel)} | ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.parentId || "-")} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(observedStatus)} | ${escapeMarkdownCell(session.updatedAt || session.createdAt || "")} | ${escapeMarkdownCell(session.summary)} |`
    );
    for (const childId of hierarchyContext.childrenByParent.get(sessionId) ?? []) {
      appendRows(childId, depth + 1);
    }
  };

  appendRows(rootSessionId, 0);
  return `${lines.join("\n")}\n`;
}

async function tryGetLiveSessionHierarchyContext(serverDirectory, directory) {
  const managedState = normalizeState(readState(serverDirectory));
  if (!managedState || !isPidRunning(managedState.pid)) {
    return null;
  }
  const baseUrl = buildBaseUrl(managedState.port);
  if (!(await checkHealth(baseUrl))) {
    return null;
  }
  try {
    const sessions = await listSessions(baseUrl, directory);
    return buildSessionHierarchyContext(sessions);
  } catch {
    return null;
  }
}

function isHierarchySessionPending({
  sessionId,
  hierarchySessionIds,
  sessionSummariesById,
  directorySessions,
  now,
  pendingGraceMs
}) {
  if (!hierarchySessionIds.has(sessionId)) {
    return false;
  }
  const trackedState = directorySessions.get(sessionId);
  const sessionSummary = sessionSummariesById.get(sessionId);
  const normalizedStatus = normalizeSessionStatus(sessionSummary?.status || trackedState?.status || "unknown");

  if (isSuccessfulTerminalSessionStatus(normalizedStatus) || isFailedTerminalSessionStatus(normalizedStatus)) {
    return false;
  }

  const latestActivityAt = latestKnownSessionActivityAt(sessionSummary, trackedState);
  if (!Number.isFinite(latestActivityAt)) {
    return isBusySessionStatus(normalizedStatus);
  }

  return now - latestActivityAt < pendingGraceMs;
}

function summarizeHierarchyProgress({
  rootSessionId,
  hierarchySessionIds,
  sessionSummariesById,
  directorySessions,
  now,
  pendingGraceMs
}) {
  const pendingSessionIds = [];
  const failedSessionIds = [];
  for (const currentSessionId of hierarchySessionIds) {
    const trackedState = directorySessions.get(currentSessionId);
    const sessionSummary = sessionSummariesById.get(currentSessionId);
    const normalizedStatus = normalizeSessionStatus(sessionSummary?.status || trackedState?.status || "unknown");
    if (isFailedTerminalSessionStatus(normalizedStatus)) {
      failedSessionIds.push(currentSessionId);
      continue;
    }
    if (
      isHierarchySessionPending({
        sessionId: currentSessionId,
        hierarchySessionIds,
        sessionSummariesById,
        directorySessions,
        now,
        pendingGraceMs
      })
    ) {
      pendingSessionIds.push(currentSessionId);
    }
  }

  return {
    pendingSessionIds,
    failedSessionIds,
    hasPendingDescendants: pendingSessionIds.some((id) => id !== rootSessionId),
    hasFailedDescendants: failedSessionIds.some((id) => id !== rootSessionId)
  };
}

function createTextStreamPrinter() {
  let output = "";

  function printDelta(snippet) {
    const normalized = String(snippet ?? "").replace(/\r/g, "");
    if (normalized.length === 0) {
      return;
    }

    process.stdout.write(normalized);
    output += normalized;
  }

  return {
    handleDelta(delta) {
      printDelta(delta);
    },
    getOutput() {
      return output;
    }
  };
}

async function createSession(baseUrl, directory) {
  const response = await requestJson(baseUrl, "/session", {
    method: "POST",
    directory,
    body: {}
  });
  const sessionId = response?.id || response?.session?.id || response?.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode did not return a session id.");
  }
  return String(sessionId);
}

function buildTaskPayload(prompt, model, agent) {
  const payload = {
    parts: [
      {
        type: "text",
        text: prompt
      }
    ]
  };
  if (model) {
    payload.model = model;
  }
  if (agent) {
    payload.agent = agent;
  }
  return payload;
}

// Agent resolution helpers. We keep a small cache of available agents per
// baseUrl+directory so we don't re-fetch on each background-worker subprocess,
// but DO re-fetch when serve restarts.
const __agentListCache = new Map();

async function listAvailableAgents(baseUrl, directory) {
  const cacheKey = `${baseUrl}::${directory}`;
  if (__agentListCache.has(cacheKey)) {
    return __agentListCache.get(cacheKey);
  }
  try {
    const response = await requestJson(baseUrl, "/agent", { directory, timeoutMs: 5000 });
    const names = Array.isArray(response)
      ? response.map((entry) => (entry && typeof entry.name === "string" ? entry.name : null)).filter(Boolean)
      : [];
    __agentListCache.set(cacheKey, names);
    return names;
  } catch (error) {
    log(`Could not list OpenCode agents: ${error.message}`);
    __agentListCache.set(cacheKey, []);
    return [];
  }
}

// Resolve which agent to send.
// Explicit --agent always wins.
// Otherwise prefer `orchestrator` when the serve exposes it, because in this
// local oh-my-opencode-slim setup that's the intended default role for
// companion-launched tasks.
async function resolveAgent(baseUrl, directory, requested) {
  if (requested) {
    return String(requested);
  }
  const availableAgents = await listAvailableAgents(baseUrl, directory);
  return availableAgents.includes("orchestrator") ? "orchestrator" : null;
}

async function listSessionMessages(baseUrl, directory, sessionId) {
  const response = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, {
    directory
  });
  return normalizeMessageArray(response);
}

function normalizeToolState(value) {
  return String(value ?? "").trim().toLowerCase();
}

const OPENCODE_FATAL_RETRY_MESSAGE_TOKENS = [
  "insufficient balance",
  "no resource package",
  "please recharge",
  "invalid api key",
  "unauthorized",
  "authentication",
  "model not found",
  "unknown model",
  "does not exist",
  "unsupported model"
];

function isFatalOpenCodeRetryMessage(message) {
  const normalized = typeof message === "string" ? message.trim().toLowerCase() : "";
  if (!normalized) {
    return false;
  }
  return OPENCODE_FATAL_RETRY_MESSAGE_TOKENS.some((token) => normalized.includes(token));
}

function messageHasPendingToolCall(messages) {
  const activeToolStates = new Set([
    "pending",
    "running",
    "active",
    "busy",
    "working",
    "in_progress",
    "in-progress"
  ]);

  for (const message of normalizeMessageArray(messages)) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object" || part.type !== "tool") {
        continue;
      }
      const toolState = normalizeToolState(part.state?.status);
      if (activeToolStates.has(toolState)) {
        return true;
      }
    }
  }

  return false;
}

async function findHierarchySessionsWithPendingToolCalls(baseUrl, directory, sessionIds) {
  const uniqueSessionIds = [...new Set((sessionIds ?? []).filter(Boolean))];
  if (uniqueSessionIds.length === 0) {
    return [];
  }

  const checks = await Promise.all(
    uniqueSessionIds.map(async (currentSessionId) => {
      try {
        const messages = await listSessionMessages(baseUrl, directory, currentSessionId);
        return messageHasPendingToolCall(messages) ? currentSessionId : null;
      } catch {
        return null;
      }
    })
  );

  return checks.filter(Boolean);
}

async function listSessions(baseUrl, directory) {
  const response = await requestJson(baseUrl, "/session", {
    directory
  });
  return normalizeMessageArray(response);
}

async function abortSession(baseUrl, directory, sessionId) {
  try {
    await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
      directory,
      body: {}
    });
  } catch (error) {
    log(`Failed to abort session ${sessionId}: ${error.message}`);
  }
}

function readPrompt(positionals) {
  if (positionals.length > 0) {
    return positionals.join(" ").trim();
  }
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8").trim();
  }
  return "";
}

function createSignalAbort(onAbort) {
  const controller = new AbortController();
  let triggered = false;
  let signalName = null;

  return {
    signal: controller.signal,
    get triggered() {
      return triggered;
    },
    get signalName() {
      return signalName;
    },
    async trigger(nextSignalName) {
      if (triggered) {
        return;
      }
      triggered = true;
      signalName = nextSignalName;
      controller.abort();
      await onAbort(nextSignalName);
    }
  };
}

async function handleCheck(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const serverDirectory = resolveServerDirectory(options["server-directory"] ?? options.directory);
  const version = await ensureOpencodeInstalled(serverDirectory);
  const managedState = normalizeState(readState(serverDirectory));
  const healthy = managedState ? await checkHealth(buildBaseUrl(managedState.port)) : false;
  const pidRunning = managedState ? isPidRunning(managedState.pid) : false;
  process.stdout.write(renderCheckResult({ directory: serverDirectory, version, managedState, healthy, pidRunning }));
}

async function handleEnsureServe(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--port", "--directory", "--server-directory"]
  });
  const serverDirectory = resolveServerDirectory(options["server-directory"] ?? options.directory);
  const requestedPort = options.port ? Number(options.port) : 0;
  if (!Number.isFinite(requestedPort) || requestedPort < 0) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const state = await ensureManagedServe(serverDirectory, requestedPort);
  process.stdout.write(renderEnsureServeResult(serverDirectory, state));
}

async function monitorSession({
  baseUrl,
  directory,
  sessionId,
  printer,
  timeoutMins = DEFAULT_SESSION_TIMEOUT_MINS,
  onSignalAbort,
  eventStreamController,
  canUseStatusPolling = () => true,
  jobId = null,
  rawModel = null,
  abortedBySignal = false
}) {
  const directorySessions = new Map(); // sessionId -> { status, lastActivityAt }
  let sessionSummariesById = new Map();
  let hierarchySessionIds = new Set([sessionId]);
  let sawDelegatedHierarchy = false;
  let lastDirectoryActivityAt = Date.now();
  let lastMainSessionActivityAt = Date.now();
  let lastPrintedSessionId = null;
  const partTypes = new Map(); // partID -> part type (e.g. "text", "reasoning", "tool")
  const QUIESCENCE_TIMEOUT_MS = readEnvDurationMs("OPENCODE_QUIESCENCE_TIMEOUT_MS", 5000);
  const FORCE_QUIESCENCE_TIMEOUT_MS = readEnvDurationMs("OPENCODE_FORCE_QUIESCENCE_TIMEOUT_MS", 30000);
  const HIERARCHY_PENDING_GRACE_MS = FORCE_QUIESCENCE_TIMEOUT_MS;
  const STATUS_POLL_INTERVAL_MS = readEnvDurationMs("OPENCODE_STATUS_POLL_INTERVAL_MS", 1500);
  const STREAM_CLOSE_GRACE_MS = readEnvDurationMs("OPENCODE_STREAM_CLOSE_GRACE_MS", 4000);
  const SETTLING_CHECK_INTERVAL_MS = readEnvDurationMs("OPENCODE_SETTLING_CHECK_INTERVAL_MS", 1000);
  const timeoutMs = timeoutMins * 60 * 1000;
  const startTime = Date.now();
  let lastStatusPollAt = 0;

  async function refreshSessionHierarchy() {
    const sessionSummaries = (await listSessions(baseUrl, directory)).map(summarizeSession);
    sessionSummariesById = new Map(sessionSummaries.map((session) => [session.id, session]));
    hierarchySessionIds = collectSessionHierarchyIds(sessionId, sessionSummaries);
    if (hierarchySessionIds.size > 1) {
      sawDelegatedHierarchy = true;
    }

    const now = Date.now();
    for (const currentSessionId of hierarchySessionIds) {
      const sessionSummary = sessionSummariesById.get(currentSessionId);
      if (!sessionSummary) {
        continue;
      }

      if (!directorySessions.has(currentSessionId)) {
        directorySessions.set(currentSessionId, {
          status: normalizeSessionStatus(sessionSummary.status),
          lastActivityAt: latestKnownSessionActivityAt(sessionSummary, null) ?? now
        });
        continue;
      }

      const trackedState = directorySessions.get(currentSessionId);
      if (sessionSummary.status && normalizeSessionStatus(sessionSummary.status) !== "unknown") {
        trackedState.status = normalizeSessionStatus(sessionSummary.status);
      }
      const refreshedActivityAt = latestKnownSessionActivityAt(sessionSummary, trackedState);
      if (Number.isFinite(refreshedActivityAt)) {
        trackedState.lastActivityAt = refreshedActivityAt;
      }
    }

    return sessionSummariesById.get(sessionId) ?? null;
  }

  const eventResponse = await openEventStream(baseUrl, directory, eventStreamController.signal);
  const eventStreamPromise = streamSseResponse(
    eventResponse.body,
    async (event) => {
      if (onSignalAbort.triggered) {
        return { aborted: true };
      }
      if (event.done) {
        return { done: true };
      }
      if (!event.payload || typeof event.payload !== "object") {
        return null;
      }

      const payload = event.payload;
      const properties = payload.properties;
      if (!properties || typeof properties !== "object") {
        return null;
      }

      const eventSessionId = properties.sessionID;
      if (eventSessionId) {
        if (!directorySessions.has(eventSessionId)) {
          directorySessions.set(eventSessionId, { status: "unknown", lastActivityAt: Date.now() });
        }
        const sessionState = directorySessions.get(eventSessionId);

        // Any event with a sessionID counts as activity (reasoning, step-start, etc.)
        sessionState.lastActivityAt = Date.now();
        lastDirectoryActivityAt = Date.now();
        if (eventSessionId === sessionId) {
          lastMainSessionActivityAt = Date.now();
        }

        // Track part types so we can filter reasoning from text deltas
        if (payload.type === "message.part.updated" && properties.part) {
          try {
            const partInfo = typeof properties.part === "string" ? JSON.parse(properties.part) : properties.part;
            if (partInfo.id && partInfo.type) {
              partTypes.set(partInfo.id, partInfo.type);
            }
            // Print brief tool call summary
            if (partInfo.type === "tool" && partInfo.state === "completed" && partInfo.name) {
              const toolSummary = `[tool: ${partInfo.name}${partInfo.result ? " ✓" : ""}]\n`;
              if (eventSessionId === sessionId) {
                printer.handleDelta(toolSummary);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        if (payload.type === "message.part.delta") {
          if (properties.field === "text") {
            // Skip reasoning/thinking parts — only stream actual text output
            const knownType = properties.partID ? partTypes.get(properties.partID) : null;
            if (knownType === "reasoning") {
              // Don't stream reasoning content
            } else if (eventSessionId === sessionId) {
              if (lastPrintedSessionId !== sessionId) {
                lastPrintedSessionId = sessionId;
              }
              printer.handleDelta(properties.delta);
            }
          }
        }

        if (payload.type === "session.status") {
          const nextStatus = normalizeSessionStatus(properties.status?.type || properties.status || "unknown");
          sessionState.status = nextStatus;
          if (nextStatus === "retry" && isFatalOpenCodeRetryMessage(properties.status?.message || properties.message)) {
            sessionState.status = "failed";
          }
        }

        if (payload.type === "session.idle") {
          sessionState.status = "idle";
        }

        if (payload.type === "session.error") {
          sessionState.status = "failed";
        }
      }

      return null;
    },
    { abortSignal: eventStreamController.signal }
  );

  // External loop to check for quiescence or timeout
  const quiescencePromise = (async () => {
    let descendantWaitLogged = false;
    let pendingToolWaitLogged = false;

    while (!onSignalAbort.triggered) {
      await delay(SETTLING_CHECK_INTERVAL_MS);

      const now = Date.now();
      if (now - startTime > timeoutMs) {
        log(`Error: Task timed out after ${timeoutMins} minutes.`);
        eventStreamController.abort();
        throw new Error(`Task timed out after ${timeoutMins} minutes.`);
      }

      const msSinceDirectoryActivity = now - lastDirectoryActivityAt;
      const shouldPollStatus = canUseStatusPolling() && now - lastStatusPollAt >= STATUS_POLL_INTERVAL_MS;

      if (shouldPollStatus) {
        lastStatusPollAt = now;
        try {
          await refreshSessionHierarchy();
        } catch {
          // Ignore status polling failures and keep waiting on the event stream.
        }
      }

      const mainSessionState = directorySessions.get(sessionId);
      const mainSessionStatus = normalizeSessionStatus(
        mainSessionState?.status || sessionSummariesById.get(sessionId)?.status || "unknown"
      );
      const isMainSuccessfulTerminal = isSuccessfulTerminalSessionStatus(mainSessionStatus);
      const isMainFailedTerminal = isFailedTerminalSessionStatus(mainSessionStatus);
      const hierarchyProgress = summarizeHierarchyProgress({
        rootSessionId: sessionId,
        hierarchySessionIds,
        sessionSummariesById,
        directorySessions,
        now,
        pendingGraceMs: HIERARCHY_PENDING_GRACE_MS
      });

      if (isMainSuccessfulTerminal && hierarchyProgress.hasPendingDescendants && !descendantWaitLogged) {
        const descendantCount = hierarchyProgress.pendingSessionIds.filter((id) => id !== sessionId).length;
        log(`Main session terminal. Waiting for ${descendantCount} descendant session(s) to settle...`);
        descendantWaitLogged = true;
      }
      if (!hierarchyProgress.hasPendingDescendants) {
        descendantWaitLogged = false;
      }

      let pendingToolSessionIds = [];
      if (hierarchyProgress.pendingSessionIds.length === 0) {
        pendingToolSessionIds = await findHierarchySessionsWithPendingToolCalls(
          baseUrl,
          directory,
          [...hierarchySessionIds]
        );
      }
      if (pendingToolSessionIds.length > 0) {
        if (!pendingToolWaitLogged) {
          log(
            `Detected pending tool call(s) in ${pendingToolSessionIds.length} session(s); continuing to wait...`
          );
          pendingToolWaitLogged = true;
        }
        continue;
      }
      pendingToolWaitLogged = false;

      if (isMainFailedTerminal) {
        log(`Finished (session status ${mainSessionStatus}) in directory ${directory}.`);
        return { done: true, terminalStatus: mainSessionStatus };
      }

      if (hierarchyProgress.hasFailedDescendants) {
        log("Finished (descendant session status failed) in directory " + directory + ".");
        return {
          done: true,
          completionMode: "descendant_failed",
          terminalStatus: "failed",
          rawSessionStatus: mainSessionStatus
        };
      }

      if (isMainSuccessfulTerminal && !hierarchyProgress.hasPendingDescendants) {
        log(`Finished (session status ${mainSessionStatus}) in directory ${directory}.`);
        return { done: true, terminalStatus: mainSessionStatus };
      }

      const hasSeenActivity = directorySessions.size > 0;
      const msSinceMainActivity = now - lastMainSessionActivityAt;
      const reachedQuiescenceFallback =
        hasSeenActivity &&
        !sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        msSinceMainActivity >= QUIESCENCE_TIMEOUT_MS;
      if (reachedQuiescenceFallback) {
        log(`Finished (quiescence) in directory ${directory}.`);
        return {
          done: true,
          completionMode: "quiescence",
          terminalStatus: "idle",
          rawSessionStatus: mainSessionStatus
        };
      }

      const reachedDelegatedFallback =
        hasSeenActivity &&
        sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        msSinceDirectoryActivity >= FORCE_QUIESCENCE_TIMEOUT_MS;
      if (reachedDelegatedFallback) {
        log(`Finished (settled after delegated activity) in directory ${directory}.`);
        return {
          done: true,
          completionMode: "delegated_settled",
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus
        };
      }
    }
    return { aborted: true };
  })();

  let streamResult = await Promise.race([eventStreamPromise, quiescencePromise]);
  if (streamResult.streamClosed) {
    const deadline = Date.now() + STREAM_CLOSE_GRACE_MS;
    while (Date.now() < deadline && !onSignalAbort.triggered) {
      try {
        const summary = canUseStatusPolling() ? await refreshSessionHierarchy() : null;
        if (summary && isTerminalSessionStatus(summary.status)) {
          break;
        }
      } catch {
        // Ignore polling errors while giving the server a brief chance to settle.
      }
      await delay(200);
    }

    const finalSummary = canUseStatusPolling() ? await getSessionSummary(baseUrl, directory, sessionId).catch(() => null) : null;
    if (!finalSummary || !isTerminalSessionStatus(finalSummary.status)) {
      throw new Error("OpenCode event stream ended before session completion.");
    }
    streamResult = {
      done: true,
      completionMode: "terminal",
      terminalStatus: normalizeSessionStatus(finalSummary.status),
      rawSessionStatus: normalizeSessionStatus(finalSummary.status)
    };
  }

  if (streamResult.aborted || onSignalAbort.triggered) {
    process.exitCode = onSignalAbort.signalName === "SIGINT" ? 130 : 143;
    if (jobId) {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: "Task was aborted."
      });
    }
    return null;
  }

  eventStreamController.abort();

  let messages = [];
  try {
    messages = await listSessionMessages(baseUrl, directory, sessionId);
  } catch (error) {
    // If we can't fetch messages, at least return what we have
  }
  
  const resultStatus = deriveResultStatus({
    terminalStatus: streamResult.terminalStatus,
    abortedBySignal,
    completionMode: streamResult.completionMode
  });

  const result = buildTaskResult({
    directory,
    sessionId,
    messages,
    streamedText: printer.getOutput(),
    status: resultStatus,
    completionMode: streamResult.completionMode ?? "terminal",
    rawSessionStatus: streamResult.rawSessionStatus ?? streamResult.terminalStatus
  });

  const streamedLength = printer.getOutput().trim().length;
  const resultLength = (result.combined_text || "").length;
  // Print combined_text if streaming missed significant content (>50% longer from API)
  // or if nothing was streamed at all
  if (result.combined_text && (!streamedLength || resultLength > streamedLength * 1.5)) {
    process.stdout.write(`\n${result.combined_text}\n`);
  }
  process.stdout.write(renderTaskSummary(result));
  const resultIsSuccessful = isSuccessfulResultStatus(result.status);
  const resultIsFailed = isFailedResultStatus(result.status);
  if (jobId) {
    if (result.status === "completed") {
      markJobFinished(directory, jobId, "completed", {
        sessionId,
        model: rawModel,
        error: null
      });
    } else if (result.status === "delegated") {
      markJobFinished(directory, jobId, "delegated", {
        sessionId,
        model: rawModel,
        error: null
      });
    } else if (resultIsFailed) {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: `OpenCode session ended with status ${result.status}.`
      });
    } else {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: `OpenCode session settled without a terminal status (${result.status}).`
      });
    }
  }
  if (!resultIsSuccessful) {
    process.exitCode = 1;
  }
  return result;
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--async", "--background"],
    stringFlags: ["--directory", "--server-directory", "--model", "--job-id", "--timeout", "--session", "--agent"]
  });

  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const directory = resolveDirectory(options.directory);
  const prompt = readPrompt(positionals);
  if (!prompt) {
    throw new Error("Task prompt is required.");
  }

  if (options.background && options.async) {
    throw new Error("Cannot combine --background with --async.");
  }

  const rawModel = options.model == null ? null : String(options.model);
  const model = parseModelOption(options.model);
  const requestedAgent = options.agent ? String(options.agent).trim() : null;
  const jobId = options["job-id"] ?? null;
  const existingSessionId = options.session ? String(options.session).trim() : null;
  const timeoutMins = options.timeout ? Number(options.timeout) : DEFAULT_SESSION_TIMEOUT_MINS;

  if (Number.isNaN(timeoutMins) || timeoutMins <= 0) {
    throw new Error(`Invalid timeout: ${options.timeout}. Use a positive number of minutes.`);
  }

  if (options.background && jobId) {
    throw new Error("The --job-id flag is reserved for internal background workers.");
  }

  if (options.background) {
    const backgroundJobId = generateJobId();
    const logFile = createJobLogFile(directory, backgroundJobId);
    appendLogLine(logFile, "Queued for background execution.");
    upsertJob(
      directory,
      buildJobRecord(directory, backgroundJobId, prompt, {
        status: "queued",
        model: rawModel,
        logFile
      })
    );

    let child;
    try {
      child = spawnBackgroundTaskWorker(directory, backgroundJobId, prompt, {
        serverDirectory,
        model: rawModel,
        agent: requestedAgent,
        timeout: timeoutMins
      });
    } catch (error) {
      markJobFinished(directory, backgroundJobId, "failed", {
        model: rawModel,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    try {
      markJobRunning(directory, backgroundJobId, {
        pid: child.pid ?? null,
        model: rawModel,
        logFile
      });
      child.unref();
    } catch (error) {
      if (child.pid && isPidRunning(child.pid)) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Ignore kill failures during cleanup.
        }
      }
      markJobFinished(directory, backgroundJobId, "failed", {
        model: rawModel,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    process.stdout.write(renderBackgroundTaskStart(backgroundJobId, fileURLToPath(import.meta.url), directory));
    return;
  }

  if (jobId) {
    const existing = readJob(directory, jobId);
    if (existing?.status === "cancelled") {
      return;
    }
    const logFile = existing?.logFile ?? jobLogFilePath(directory, jobId);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, "", "utf8");
    }
    const current = readJob(directory, jobId);
    if (current?.status === "cancelled") {
      return;
    }
    upsertJob(
      directory,
      buildJobRecord(directory, jobId, prompt, {
        status: "running",
        startedAt: existing?.startedAt ?? nowIso(),
        model: rawModel ?? existing?.model ?? null,
        pid: process.pid,
        logFile,
        sessionId: existing?.sessionId ?? null
      })
    );
  }

  let state = null;
  let baseUrl = null;
  let sessionId = null;
  let abortedBySignal = false;
  let shouldExit = false;
  const taskLifecycle = { promptSubmitted: false };
  const eventStreamController = new AbortController();
  const onSignalAbort = createSignalAbort(async (signal) => {
    abortedBySignal = true;
    if (sessionId) {
      log(`Received ${signal}; aborting OpenCode session ${sessionId}.`);
      await abortSession(baseUrl, directory, sessionId);
    }
  });

  const sigintHandler = () => {
    eventStreamController.abort();
    void onSignalAbort.trigger("SIGINT");
  };
  const sigtermHandler = () => {
    eventStreamController.abort();
    void onSignalAbort.trigger("SIGTERM");
  };
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    state = await ensureManagedServe(serverDirectory, 0);
    baseUrl = buildBaseUrl(state.port);
    if (existingSessionId) {
      sessionId = existingSessionId;
      log(`Resuming OpenCode session ${sessionId} on port ${state.port}.`);
    } else {
      sessionId = await createSession(baseUrl, directory);
      log(`Created OpenCode session ${sessionId} on port ${state.port}.`);
    }

    var resolvedAgent = await resolveAgent(baseUrl, directory, requestedAgent);
    if (resolvedAgent) {
      log(`Using OpenCode agent: ${resolvedAgent}${requestedAgent ? "" : " (auto-selected)"}`);
    }

    if (jobId) {
      const currentJob = readJob(directory, jobId);
      if (currentJob?.status === "cancelled") {
        log(`Job ${jobId} was cancelled before startup; exiting worker.`);
        return;
      }
      upsertJob(directory, {
        ...buildJobRecord(directory, jobId, prompt, {
          status: "running",
          startedAt: readJob(directory, jobId)?.startedAt ?? nowIso(),
          model: rawModel ?? null,
          pid: process.pid,
          sessionId,
          logFile: jobLogFilePath(directory, jobId)
        }),
        sessionId,
        status: "running",
        pid: process.pid,
        error: null
      });
    }

    if (options.async) {
      await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        directory,
        body: buildTaskPayload(prompt, model, resolvedAgent)
      });
      process.stdout.write(
        [
          `Queued OpenCode session ${sessionId}.`,
          `Directory: ${directory}`,
          `Server: ${buildBaseUrl(state.port)}`
        ].join("\n") + "\n"
      );
      if (jobId) {
        markJobFinished(directory, jobId, "completed", {
          sessionId,
          model: rawModel,
          error: null
        });
      }
      return;
    }

    const printer = createTextStreamPrinter();
    const monitorPromise = monitorSession({
      baseUrl,
      directory,
      sessionId,
      printer,
      timeoutMins,
      onSignalAbort,
      eventStreamController,
      canUseStatusPolling: () => taskLifecycle.promptSubmitted,
      jobId,
      rawModel,
      abortedBySignal
    });

    // Start the task asynchronously
    try {
      await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        directory,
        body: buildTaskPayload(prompt, model, resolvedAgent),
        timeoutMs: 30000, // Small timeout for starting the task
        signal: onSignalAbort.signal
      });
      taskLifecycle.promptSubmitted = true;
    } catch (error) {
      eventStreamController.abort();
      if (!onSignalAbort.triggered || !isAbortError(error)) {
        throw error;
      }
    }

    const result = await monitorPromise;
    if (!result) {
      return;
    }
    if (!isFailedTerminalSessionStatus(result.status)) {
      shouldExit = true;
    }
  } catch (error) {
    if (isAbortError(error) && !onSignalAbort.triggered) {
      if (jobId) {
        markJobFinished(directory, jobId, "failed", {
          sessionId,
          model: rawModel,
          error: "OpenCode aborted the task request before it completed."
        });
      }
      throw formatUnexpectedTaskAbort(model);
    }
    if (jobId) {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }

  if (shouldExit) {
    process.exit(0);
  }
}

async function handleReview(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return;
  }

  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--wait", "--background", "--adversarial"],
    stringFlags: ["--base", "--scope", "--directory", "--server-directory", "--model", "--timeout"]
  });

  const directory = resolveDirectory(options.directory);
  const reviewScope = normalizeReviewScope(options.scope);
  const baseRef = options.base ? String(options.base).trim() : null;
  const focusText = positionals.join(" ").trim();

  if (options.wait && options.background) {
    throw new Error("Cannot combine --wait with --background.");
  }

  let context = null;

  if (reviewScope === "working-tree") {
    context = await collectWorkingTreeReviewContext(directory);
  } else if (reviewScope === "branch") {
    const selectedBase = baseRef || (await resolveDefaultReviewBaseRef(directory));
    if (!selectedBase) {
      throw new Error("Unable to resolve a base ref for branch review. Pass --base REF.");
    }
    context = await collectBranchReviewContext(directory, selectedBase);
  } else {
    const currentBranch = await getCurrentGitBranch(directory);
    const selectedBase = baseRef || (await resolveDefaultReviewBaseRef(directory));
    const isMainBranch = !currentBranch || currentBranch === "main" || currentBranch === "master";

    if (!isMainBranch && selectedBase) {
      const aheadCount = await getAheadCommitCount(directory, selectedBase);
      if (aheadCount > 0) {
        context = await collectBranchReviewContext(directory, selectedBase);
      }
    }

    if (!context) {
      context = await collectWorkingTreeReviewContext(directory);
    }
  }

  const prompt = buildReviewPrompt(context, {
    adversarial: Boolean(options.adversarial),
    focusText: focusText || null
  });

  const taskArgs = [];
  taskArgs.push("--directory", directory);
  if (options["server-directory"]) {
    taskArgs.push("--server-directory", String(options["server-directory"]));
  }
  if (options.model) {
    taskArgs.push("--model", String(options.model));
  }
  if (options.background) {
    taskArgs.push("--background");
  }
  if (options.timeout) {
    taskArgs.push("--timeout", String(options.timeout));
  }
  taskArgs.push("--", prompt);

  await handleTask(taskArgs);
}

async function handleAttach(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory", "--timeout"]
  });

  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const directory = resolveDirectory(options.directory);
  let sessionId = positionals[0] ?? null;
  const timeoutMins = options.timeout ? Number(options.timeout) : DEFAULT_SESSION_TIMEOUT_MINS;

  if (Number.isNaN(timeoutMins) || timeoutMins <= 0) {
    throw new Error(`Invalid timeout: ${options.timeout}. Use a positive number of minutes.`);
  }

  const state = normalizeState(readState(serverDirectory));
  if (!state) {
    throw new Error(`No managed OpenCode serve state found for ${serverDirectory}. Is it running?`);
  }

  const baseUrl = buildBaseUrl(state.port);
  const healthy = await checkHealth(baseUrl);
  if (!healthy) {
    throw new Error(`OpenCode serve at ${baseUrl} is not reachable.`);
  }

  if (!sessionId) {
    const sessions = await listSessions(baseUrl, directory);
    if (sessions.length === 0) {
      throw new Error("No sessions found to attach to.");
    }
    // Default to the most recent one
    sessionId = summarizeSession(sessions[0]).id;
    log(`Attaching to most recent session: ${sessionId}`);
  }

  log(`Attaching to OpenCode session ${sessionId} on port ${state.port}.`);

  const eventStreamController = new AbortController();
  const onSignalAbort = createSignalAbort(async (signal) => {
    log(`Received ${signal}; detaching from session ${sessionId}.`);
    // We don't abort the session on attach detach
  });

  const sigintHandler = () => {
    eventStreamController.abort();
    void onSignalAbort.trigger("SIGINT");
  };
  const sigtermHandler = () => {
    eventStreamController.abort();
    void onSignalAbort.trigger("SIGTERM");
  };
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    const printer = createTextStreamPrinter();
    await monitorSession({
      baseUrl,
      directory,
      sessionId,
      printer,
      timeoutMins,
      onSignalAbort,
      eventStreamController,
      canUseStatusPolling: () => true
    });
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--all"],
    stringFlags: ["--directory", "--server-directory"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const hierarchyContext = await tryGetLiveSessionHierarchyContext(serverDirectory, directory);
  const jobId = positionals[0] ?? null;

  if (jobId) {
    const job = refreshStaleRunningJobs(directory).find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      throw new Error(`No job found for ${jobId}.`);
    }
    process.stdout.write(buildSingleJobView(job, hierarchyContext));
    return;
  }

  process.stdout.write(buildJobListView(directory, { all: Boolean(options.all), sessionHierarchyContext: hierarchyContext }));
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const hierarchyContext = await tryGetLiveSessionHierarchyContext(serverDirectory, directory);
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for result.");
  }

  const job = readJob(directory, jobId);
  if (!job) {
    throw new Error(`No job found for ${jobId}.`);
  }

  const logText = readLogText(job.logFile);
  const hierarchySection = renderJobHierarchySection(job, hierarchyContext).trimEnd();
  if (job.status === "running" || job.status === "queued") {
    process.stdout.write(`Job ${job.id} is still in progress. Showing current log.\n`);
  }
  if (hierarchySection) {
    process.stdout.write(`${hierarchySection}\n\n`);
  }

  if (logText.trim()) {
    process.stdout.write(logText.endsWith("\n") ? logText : `${logText}\n`);
  } else {
    process.stdout.write("No log output captured for this job.\n");
  }

  if (job.status === "failed" && job.error) {
    process.stdout.write(`Error: ${job.error}\n`);
  }
  if (job.status === "cancelled") {
    process.stdout.write(`Job ${job.id} was cancelled.\n`);
  }
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const directory = resolveDirectory(options.directory);
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for cancel.");
  }

  const job = readJob(directory, jobId);
  if (!job) {
    throw new Error(`No job found for ${jobId}.`);
  }
  if (!isActiveJob(job)) {
    throw new Error(`Job ${jobId} is not running.`);
  }

  const pid = Number.isInteger(job.pid) && job.pid > 0 ? job.pid : null;
  if (pid && isPidRunning(pid)) {
    process.kill(pid, "SIGTERM");
  }

  appendLogLine(job.logFile, "Cancelled by user.");
  markJobFinished(directory, jobId, "cancelled", {
    error: null
  });

  if (pid) {
    await delay(150);
    if (isPidRunning(pid)) {
      await terminateProcess(pid);
    }
  }

  process.stdout.write(`Cancelled background job ${jobId}.\n`);
}

async function handleCleanup(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const serverDirectory = resolveServerDirectory(options["server-directory"] ?? options.directory);
  const state = normalizeState(readState(serverDirectory));

  if (!state) {
    process.stdout.write(renderCleanupResult(serverDirectory, { found: false }));
    return;
  }

  const wasRunning = isPidRunning(state.pid);
  if (wasRunning) {
    await terminateProcess(state.pid);
  }
  removeState(serverDirectory);

  process.stdout.write(
    renderCleanupResult(serverDirectory, {
      found: true,
      wasRunning,
      pid: state.pid,
      port: state.port
    })
  );
}

async function getReadySessionRuntime(serverDirectory) {
  const state = await ensureManagedServe(serverDirectory, 0);
  return { state, baseUrl: buildBaseUrl(state.port) };
}

async function handleSessionList(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const directory = resolveDirectory(options.directory);
  const { baseUrl } = await getReadySessionRuntime(serverDirectory);
  const sessions = await listSessions(baseUrl, directory);
  process.stdout.write(buildSessionListView(directory, sessions));
}

async function handleSessionStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory"]
  });
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const directory = resolveDirectory(options.directory);
  const sessionId = positionals[0];
  if (!sessionId) {
    await handleSessionList(argv);
    return;
  }
  const { baseUrl } = await getReadySessionRuntime(serverDirectory);
  const sessions = await listSessions(baseUrl, directory);
  const hierarchyContext = buildSessionHierarchyContext(sessions);
  const session = sessions.find((entry) => summarizeSession(entry).id === sessionId) ?? null;
  if (!session) {
    throw new Error(`No session found for ${sessionId} in ${directory}.`);
  }
  process.stdout.write(buildSingleSessionView(directory, session, hierarchyContext));
}

async function handleSessionCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  if (subcommand === "new") {
    await handleTask(rest);
    return;
  }

  if (subcommand === "continue" || subcommand === "resume") {
    const { options, positionals } = parseArgs(rest, {
      booleanFlags: ["--async", "--background"],
      stringFlags: ["--directory", "--server-directory", "--model", "--timeout"]
    });
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error(`Missing session id for session ${subcommand}.`);
    }
    const taskArgs = [];
    if (options.directory) taskArgs.push("--directory", String(options.directory));
    if (options["server-directory"]) taskArgs.push("--server-directory", String(options["server-directory"]));
    if (options.model) taskArgs.push("--model", String(options.model));
    if (options.timeout) taskArgs.push("--timeout", String(options.timeout));
    if (options.async) taskArgs.push("--async");
    if (options.background) taskArgs.push("--background");
    taskArgs.push("--session", String(sessionId));
    if (positionals.length > 1) {
      taskArgs.push("--", ...positionals.slice(1));
    }
    await handleTask(taskArgs);
    return;
  }

  if (subcommand === "attach") {
    await handleAttach(rest);
    return;
  }

  if (subcommand === "wait") {
    await handleAttach(rest);
    return;
  }

  if (subcommand === "list") {
    await handleSessionList(rest);
    return;
  }

  if (subcommand === "status") {
    await handleSessionStatus(rest);
    return;
  }

  throw new Error(`Unknown session command: ${subcommand}`);
}

async function handleServeCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  if (subcommand === "start") {
    await handleEnsureServe(rest);
    return;
  }
  if (subcommand === "status") {
    await handleCheck(rest);
    return;
  }
  if (subcommand === "stop") {
    await handleCleanup(rest);
    return;
  }
  throw new Error(`Unknown serve command: ${subcommand}`);
}

async function handleJobCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  if (subcommand === "list") {
    await handleStatus(rest);
    return;
  }
  if (subcommand === "status") {
    await handleStatus(rest);
    return;
  }
  if (subcommand === "wait") {
    await handleJobWait(rest);
    return;
  }
  if (subcommand === "result") {
    await handleResult(rest);
    return;
  }
  if (subcommand === "cancel") {
    await handleCancel(rest);
    return;
  }
  throw new Error(`Unknown job command: ${subcommand}`);
}

async function handleJobWait(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory", "--timeout"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for job wait.");
  }
  const timeoutMins = options.timeout ? Number(options.timeout) : DEFAULT_SESSION_TIMEOUT_MINS;
  if (Number.isNaN(timeoutMins) || timeoutMins <= 0) {
    throw new Error(`Invalid timeout: ${options.timeout}. Use a positive number of minutes.`);
  }

  const deadline = Date.now() + timeoutMins * 60 * 1000;
  while (Date.now() < deadline) {
    const job = refreshStaleRunningJobs(directory).find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      throw new Error(`No job found for ${jobId}.`);
    }
    if (!isActiveJob(job)) {
      await handleResult([jobId, "--directory", directory, "--server-directory", serverDirectory]);
      return;
    }
    await delay(1500);
  }

  throw new Error(`Timed out after ${timeoutMins} minutes waiting for job ${jobId}.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "serve") {
    await handleServeCommand(rest);
    return;
  }
  if (command === "session") {
    await handleSessionCommand(rest);
    return;
  }
  if (command === "job") {
    await handleJobCommand(rest);
    return;
  }
  if (command === "review") {
    await handleReview(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main()
    .then(() => {
      process.exit(process.exitCode ?? 0);
    })
    .catch((error) => {
      stderr(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

export {
  buildReviewPrompt,
  deriveResultStatus,
  generateJobId,
  formatDuration,
  isBusySessionStatus,
  isFailedTerminalSessionStatus,
  isActiveJob,
  isPidRunning,
  isSuccessfulTerminalSessionStatus,
  normalizePromptText,
  parseArgs,
  parseSseBlock,
  readJobs,
  readLogTail,
  refreshStaleRunningJobs,
  renderBackgroundTaskStart,
  renderTaskSummary,
  resolveDirectory,
  summarizePrompt,
  upsertJob,
  buildSessionListView,
  buildSingleSessionView,
  deriveSessionLifecycleVerdict,
  recommendSessionAction
};
