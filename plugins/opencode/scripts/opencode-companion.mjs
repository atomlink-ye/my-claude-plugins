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
const MESSAGE_POST_TIMEOUT_MS = 300000;
const STATUS_SESSION_LIMIT = 10;
const MAX_STORED_JOBS = 50;
const STATUS_RECENT_LIMIT = 5;
const STATUS_LOG_TAIL_LINES = 5;

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/opencode-companion.mjs check [--directory DIR]",
      "  node scripts/opencode-companion.mjs ensure-serve [--port N] [--directory DIR]",
      "  node scripts/opencode-companion.mjs task [--directory DIR] [--model MODEL] [--session SESSION_ID] [--async] [--background] PROMPT",
      "  node scripts/opencode-companion.mjs sessions [--directory DIR] [--session SESSION_ID] [--since MINUTES] [--limit N]",
      "  node scripts/opencode-companion.mjs review [--wait|--background] [--base REF] [--scope auto|working-tree|branch] [--adversarial] [focus text] [--directory DIR] [--model MODEL]",
      "  node scripts/opencode-companion.mjs status [job-id] [--directory DIR] [--all]",
      "  node scripts/opencode-companion.mjs result <job-id> [--directory DIR]",
      "  node scripts/opencode-companion.mjs cancel <job-id> [--directory DIR]",
      "  node scripts/opencode-companion.mjs cleanup [--directory DIR]"
    ].join("\n") + "\n"
  );
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function log(message) {
  stderr(`[opencode] ${message}`);
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

function resolveDirectory(input) {
  const resolved = path.resolve(input ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
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

function serveWorkingDirectory() {
  // The OpenCode serve routes each request by `x-opencode-directory`, so its
  // own process cwd is only consulted as a last-resort fallback. Running it
  // from the user's home keeps it project-agnostic: a single managed serve
  // can host multiple project workspaces without accumulating stale state
  // under whichever project happened to start it. The env override
  // OPENCODE_COMPANION_SERVE_CWD lets operators pick a different location
  // (e.g. a dedicated runtime dir) without editing this script.
  const override = process.env.OPENCODE_COMPANION_SERVE_CWD;
  if (override) {
    const resolved = path.resolve(override);
    try {
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        return resolved;
      }
    } catch (error) {
      // fall through to home
    }
  }
  return os.homedir();
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

async function choosePort(requestedPort) {
  const numeric = Number(requestedPort ?? 0);
  if (Number.isInteger(numeric) && numeric > 0) {
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

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function lastNonEmptyLine(value) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.at(-1) ?? "";
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
  const [branch, head, statusShort, stagedQuiet, unstagedQuiet, stagedStat, unstagedStat] = await Promise.all([
    getCurrentGitBranch(directory),
    gitText(directory, ["rev-parse", "--short", "HEAD"], { allowNonZero: true }),
    gitText(directory, ["status", "--short", "--untracked-files=all"]),
    runGitCommand(directory, ["diff", "--cached", "--quiet"], { allowNonZero: true }),
    runGitCommand(directory, ["diff", "--quiet"], { allowNonZero: true }),
    gitText(directory, ["diff", "--cached", "--stat"], { allowNonZero: true }),
    gitText(directory, ["diff", "--stat"], { allowNonZero: true })
  ]);

  const hasStaged = stagedQuiet.exitCode === 1;
  const hasUnstaged = unstagedQuiet.exitCode === 1;

  if (!statusShort.trim() && !hasStaged && !hasUnstaged) {
    throw new Error("No staged or unstaged changes found for working-tree review.");
  }

  return {
    scope: "working-tree",
    directory,
    branch,
    head: head || null,
    hasStaged,
    hasUnstaged,
    statusShort,
    stagedStatFooter: lastNonEmptyLine(stagedStat),
    unstagedStatFooter: lastNonEmptyLine(unstagedStat)
  };
}

async function collectBranchReviewContext(directory, baseRef) {
  const [branch, head, commitLog, statText] = await Promise.all([
    getCurrentGitBranch(directory),
    gitText(directory, ["rev-parse", "--short", "HEAD"]),
    gitText(directory, ["log", "--oneline", `${baseRef}..HEAD`]),
    gitText(directory, ["diff", "--stat", `${baseRef}...HEAD`], { allowNonZero: true })
  ]);

  if (!commitLog.trim() && !statText.trim()) {
    throw new Error(`No commits or diff found between ${baseRef} and HEAD for branch review.`);
  }

  return {
    scope: "branch",
    directory,
    branch,
    base: baseRef,
    head: head || null,
    commitLog,
    statFooter: lastNonEmptyLine(statText)
  };
}

function buildReviewPrompt(metadata, { adversarial = false, focusText = null } = {}) {
  const sections = [];
  const directory = shellSingleQuote(metadata.directory);

  if (metadata.scope === "branch") {
    sections.push(`You are reviewing the branch of ${metadata.directory}.`);
    sections.push(`Branch: ${metadata.branch ?? "detached HEAD"}. Base: ${metadata.base}. Head: ${metadata.head ?? "unknown"}.`);
  } else {
    sections.push(`You are reviewing the working-tree of ${metadata.directory}.`);
    sections.push(`Branch: ${metadata.branch ?? "detached HEAD"}. Head: ${metadata.head ?? "unknown"}.`);
  }

  if (adversarial) {
    sections.push(
      "",
      "You are performing an adversarial code review. Challenge design decisions, question tradeoffs, and identify assumptions."
    );
  }

  const commands =
    metadata.scope === "branch"
      ? [
          `  git -C ${directory} log --oneline ${metadata.base}..HEAD`,
          `  git -C ${directory} diff ${metadata.base}...HEAD`,
          `  git -C ${directory} diff --stat ${metadata.base}...HEAD`
        ]
      : [
          `  git -C ${directory} status --short`,
          `  git -C ${directory} diff --cached`,
          `  git -C ${directory} diff`,
          `  git -C ${directory} diff --cached --stat`,
          `  git -C ${directory} diff --stat`
        ];

  sections.push(
    "",
    "Run the following commands yourself inside the session to read the changes. Do NOT rely on a pre-pasted diff; there isn't one.",
    "",
    ...commands,
    ""
  );

  if (metadata.scope === "branch" && metadata.commitLog?.trim()) {
    sections.push("Commit log:", metadata.commitLog.trimEnd(), "");
  }

  if (metadata.scope === "working-tree" && metadata.statusShort?.trim()) {
    sections.push("Status snapshot:", metadata.statusShort.trimEnd(), "");
  }

  const statLines =
    metadata.scope === "branch"
      ? [metadata.statFooter].filter(Boolean)
      : [
          metadata.stagedStatFooter ? `Staged: ${metadata.stagedStatFooter}` : "",
          metadata.unstagedStatFooter ? `Unstaged: ${metadata.unstagedStatFooter}` : ""
        ].filter(Boolean);

  sections.push("Stat summary:");
  if (statLines.length > 0) {
    sections.push(...statLines);
  }

  sections.push("", "Report findings by severity (Critical/High/Medium/Low) with file paths and line numbers.");

  if (focusText) {
    sections.push("", `Focus the review on: ${focusText}`);
  }

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

function renderJobTable(jobs) {
  const lines = [
    "| id | status | started | elapsed | model | prompt | pid |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];

  if (jobs.length === 0) {
    lines.push("| none | - | - | - | - | No jobs recorded yet. | - |");
    return `${lines.join("\n")}\n`;
  }

  for (const job of jobs) {
    lines.push(
      `| ${escapeTableCell(job.id)} | ${escapeTableCell(job.status ?? "")} | ${escapeTableCell(job.startedAt ?? "")} | ${escapeTableCell(job.elapsed ?? "")} | ${escapeTableCell(job.model ?? "")} | ${escapeTableCell(job.promptSummary ?? "")} | ${escapeTableCell(job.pid ?? "")} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderJobDetails(job) {
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
  const dirFlag = directory ? ` --directory ${shellSingleQuote(directory)}` : "";
  return `OpenCode task started in background as ${jobId}. Check status: node ${shellSingleQuote(script)} status ${jobId}${dirFlag}\n`;
}

function createJobLogFile(directory, jobId) {
  const logFile = jobLogFilePath(directory, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

function spawnBackgroundTaskWorker(directory, jobId, prompt, args = {}) {
  const scriptPath = fileURLToPath(import.meta.url);
  const childArgs = [scriptPath, "task", "--job-id", jobId, "--directory", directory];

  if (args.model) {
    childArgs.push("--model", args.model);
  }

  if (args.session) {
    childArgs.push("--session", args.session);
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

  const lines = ["# OpenCode Status", "", `Directory: ${directory}`, "", renderJobTable(enriched).trimEnd()];

  const runningJobs = enriched.filter((job) => isActiveJob(job));
  if (runningJobs.length > 0) {
    lines.push("", "Running jobs:");
    for (const job of runningJobs) {
      lines.push(`- ${formatJobStatusLine(job)}`);
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

function buildSingleJobView(job) {
  const enriched = {
    ...job,
    elapsed:
      job.status === "running" || job.status === "queued"
        ? formatDuration(job.startedAt)
        : formatDuration(job.startedAt, job.completedAt)
  };
  const tail = readLogTail(job.logFile, STATUS_LOG_TAIL_LINES);
  const sections = ["# OpenCode Job Status", "", renderJobDetails(enriched).trimEnd()];
  if (tail.length > 0) {
    sections.push(renderJobTailSection(enriched).trimEnd());
  }
  return `${sections.filter(Boolean).join("\n").trimEnd()}\n`;
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
      ? `${model.providerID}/${model.modelID}`
      : model.modelID
    : "default";

  return new Error(
    [
      `OpenCode aborted the foreground stream for this task (model: ${modelLabel}).`,
      "IMPORTANT: this does NOT necessarily mean the OpenCode session is dead.",
      "When a task triggers heavy planning or sub-agent delegation (@explorer, @librarian, @oracle, @designer, etc.),",
      "the foreground request can be aborted while the underlying session keeps running on the serve.",
      "Before retrying, check whether the session is still active:",
      "  node scripts/opencode-companion.mjs sessions",
      "If a session titled like your task shows verdict=active, DO NOT retry — it is still working.",
      "Only retry if the session is absent or verdict=idle. When you retry, prefer a narrower scope",
      "or explicitly instruct OpenCode not to delegate to sub-agents for stable foreground completion."
    ].join("\n")
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

  // Spawn the serve from the user's home so its process-level cwd is
  // decoupled from any specific project directory. The serve routes every
  // request by the `x-opencode-directory` header / query param anyway, and
  // session data lives in the global DB at `~/.local/share/opencode/`. A
  // neutral cwd avoids pinning state fallbacks, plugin cascades, and
  // process.cwd()-derived defaults to whichever project dir happened to
  // launch the companion.
  const serveCwd = serveWorkingDirectory();
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", HOSTNAME, "--print-logs"], {
    cwd: serveCwd,
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

  // See runServeProbe() comment: always run the serve from a neutral cwd
  // (the user's home by default) so its process-level state is decoupled
  // from whichever project's companion invocation happened to spawn it.
  const serveCwd = serveWorkingDirectory();
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", HOSTNAME], {
    cwd: serveCwd,
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

function buildTaskResult({ directory, sessionId, messages, streamedText, status }) {
  const assistantNodes = collectAssistantNodes(messages);
  const preferredNode = assistantNodes.at(-1) ?? normalizeMessageArray(messages).at(-1) ?? messages;
  const textParts = extractTextCandidates(preferredNode);
  const combinedText = textParts.join("\n\n").trim() || String(streamedText ?? "").trim();
  const fileChanges = extractFileChanges(messages);

  return {
    session_id: String(sessionId),
    directory,
    status,
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

  if (result.file_changes.length > 0) {
    lines.push("File changes:");
    for (const change of result.file_changes) {
      lines.push(formatChangeEntry(change));
    }
  } else {
    lines.push("File changes: none reported.");
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

function renderCheckResult({ directory, version, port }) {
  return [
    "OpenCode companion check passed.",
    `Directory: ${directory}`,
    `OpenCode version: ${version}`,
    `Serve probe port: ${port}`
  ].join("\n") + "\n";
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
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

  const time = session.time && typeof session.time === "object" ? session.time : {};
  const createdRaw =
    time.created ?? session.createdAt ?? session.created_at ?? session.startedAt ?? "";
  const updatedRaw =
    time.updated ?? session.updatedAt ?? session.updated_at ?? session.modifiedAt ?? "";

  const createdAtMs = toEpochMs(createdRaw);
  const updatedAtMs = toEpochMs(updatedRaw);

  return {
    id: session.id || session.sessionID || session.sessionId || "unknown",
    status: String(status),
    createdAt: createdAtMs != null ? new Date(createdAtMs).toISOString() : String(createdRaw || ""),
    updatedAt: updatedAtMs != null ? new Date(updatedAtMs).toISOString() : String(updatedRaw || ""),
    createdAtMs,
    updatedAtMs,
    summary: String(summary || "")
  };
}

function toEpochMs(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // OpenCode serves Unix-ms numbers for time.created / time.updated.
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelativeAge(ms) {
  if (ms == null) {
    return "unknown";
  }
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
            return { done: true };
          }
          const result = await onEvent(event);
          if (result?.done || result?.aborted) {
            await cancelReader();
            return { aborted: Boolean(result.aborted) };
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
          return { done: true };
        }
        const result = await onEvent(event);
        if (result?.done || result?.aborted) {
          await cancelReader();
          return { aborted: Boolean(result.aborted) };
        }
      }
    }

    if (aborted) {
      return { aborted: true };
    }

    throw new Error("OpenCode event stream ended before session.idle.");
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }
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

function buildTaskPayload(prompt, model) {
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
  return payload;
}

async function listSessionMessages(baseUrl, directory, sessionId) {
  const response = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, {
    directory
  });
  return normalizeMessageArray(response);
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
    stringFlags: ["--directory"]
  });
  const directory = resolveDirectory(options.directory);
  const version = await ensureOpencodeInstalled(directory);
  const probe = await runServeProbe(directory, 0);
  if (!probe.ok) {
    const detail = probe.error?.message || firstNonEmptyLine(probe.logs) || "Unknown startup failure.";
    throw new Error(`OpenCode is installed but serve could not start. ${detail}`);
  }
  process.stdout.write(renderCheckResult({ directory, version, port: probe.port }));
}

async function handleEnsureServe(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--port", "--directory"]
  });
  const directory = resolveDirectory(options.directory);
  const requestedPort = options.port ? Number(options.port) : 0;
  if (!Number.isFinite(requestedPort) || requestedPort < 0) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const state = await ensureManagedServe(directory, requestedPort);
  process.stdout.write(renderEnsureServeResult(directory, state));
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--async", "--background"],
    stringFlags: ["--directory", "--model", "--job-id", "--session"]
  });

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
  const jobId = options["job-id"] ?? null;
  const resumeSessionId =
    options.session != null && String(options.session).trim() !== ""
      ? String(options.session).trim()
      : null;

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
        model: rawModel,
        session: resumeSessionId
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
    state = await ensureManagedServe(directory, 0);
    baseUrl = buildBaseUrl(state.port);
    if (resumeSessionId) {
      sessionId = resumeSessionId;
      log(`Resuming OpenCode session ${sessionId} on port ${state.port}.`);
    } else {
      sessionId = await createSession(baseUrl, directory);
      log(`Created OpenCode session ${sessionId} on port ${state.port}.`);
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
        body: buildTaskPayload(prompt, model)
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

        if (
          payload.type === "message.part.delta" &&
          properties.sessionID === sessionId &&
          properties.field === "text"
        ) {
          printer.handleDelta(properties.delta);
          return null;
        }

        if (payload.type === "session.idle" && properties.sessionID === sessionId) {
          return { done: true };
        }

        return null;
      },
      { abortSignal: eventStreamController.signal }
    );
    let postCompletedSuccessfully = false;
    let eventStreamFailedBeforePostCompleted = false;
    const guardedEventStreamPromise = eventStreamPromise.catch((error) => {
      if (!postCompletedSuccessfully) {
        eventStreamFailedBeforePostCompleted = true;
      }
      throw error;
    });

    let postResult = null;
    try {
      postResult = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        directory,
        body: buildTaskPayload(prompt, model),
        timeoutMs: MESSAGE_POST_TIMEOUT_MS,
        signal: onSignalAbort.signal
      });
      postCompletedSuccessfully = true;
    } catch (error) {
      eventStreamController.abort();
      await guardedEventStreamPromise.catch(() => {});
      if (!onSignalAbort.triggered || !isAbortError(error)) {
        throw error;
      }
    }

    let streamResult;
    try {
      streamResult = await guardedEventStreamPromise;
    } catch (error) {
      if (eventStreamFailedBeforePostCompleted) {
        throw error;
      }
      log(`Warning: GET /event stream ended before session.idle for session ${sessionId}; continuing because the message POST completed.`);
      streamResult = { done: true };
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
      return;
    }

    eventStreamController.abort();

    let messages = [];
    try {
      messages = await listSessionMessages(baseUrl, directory, sessionId);
    } catch (error) {
      messages = normalizeMessageArray(postResult);
      if (messages.length === 0) {
        throw error;
      }
    }
    const result = buildTaskResult({
      directory,
      sessionId,
      messages,
      streamedText: printer.getOutput(),
      status: abortedBySignal ? "aborted" : "completed"
    });

    if (!printer.getOutput().trim() && result.combined_text) {
      process.stdout.write(`${result.combined_text}\n`);
    }
    process.stdout.write(renderTaskSummary(result));
    if (jobId) {
      markJobFinished(directory, jobId, "completed", {
        sessionId,
        model: rawModel,
        error: null
      });
    }
    shouldExit = true;
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
    stringFlags: ["--base", "--scope", "--directory", "--model"]
  });

  const directory = resolveDirectory(options.directory);
  const reviewScope = normalizeReviewScope(options.scope);
  const baseRef = options.base ? String(options.base).trim() : null;
  const focusText = positionals.join(" ").trim();

  if (options.wait && options.background) {
    throw new Error("Cannot combine --wait with --background.");
  }

  let metadata = null;

  if (reviewScope === "working-tree") {
    metadata = await collectWorkingTreeReviewContext(directory);
  } else if (reviewScope === "branch") {
    const selectedBase = baseRef || (await resolveDefaultReviewBaseRef(directory));
    if (!selectedBase) {
      throw new Error("Unable to resolve a base ref for branch review. Pass --base REF.");
    }
    metadata = await collectBranchReviewContext(directory, selectedBase);
  } else {
    const currentBranch = await getCurrentGitBranch(directory);
    const selectedBase = baseRef || (await resolveDefaultReviewBaseRef(directory));
    const isMainBranch = !currentBranch || currentBranch === "main" || currentBranch === "master";

    if (!isMainBranch && selectedBase) {
      const aheadCount = await getAheadCommitCount(directory, selectedBase);
      if (aheadCount > 0) {
        metadata = await collectBranchReviewContext(directory, selectedBase);
      }
    }

    if (!metadata) {
      metadata = await collectWorkingTreeReviewContext(directory);
    }
  }

  const prompt = buildReviewPrompt(metadata, {
    adversarial: Boolean(options.adversarial),
    focusText: focusText || null
  });

  const taskArgs = [];
  taskArgs.push("--directory", directory);
  if (options.model) {
    taskArgs.push("--model", String(options.model));
  }
  if (options.background) {
    taskArgs.push("--background");
  }
  taskArgs.push("--", prompt);

  await handleTask(taskArgs);
}

async function handleSessions(argv) {
  const { options } = parseArgs(argv, {
    stringFlags: ["--directory", "--session", "--since", "--limit"]
  });
  const directory = resolveDirectory(options.directory);
  const sinceMinutes = options.since != null ? Number(options.since) : 5;
  if (!Number.isFinite(sinceMinutes) || sinceMinutes < 0) {
    throw new Error(`Invalid --since value: ${options.since}`);
  }
  const limit = options.limit != null ? Math.max(1, Number(options.limit)) : 10;
  if (!Number.isFinite(limit)) {
    throw new Error(`Invalid --limit value: ${options.limit}`);
  }
  const sessionFilter = options.session ? String(options.session).trim() : null;

  const state = normalizeState(readState(directory));
  if (!state) {
    process.stdout.write(`No managed OpenCode serve state found for ${directory}.\n`);
    process.exitCode = 1;
    return;
  }
  const baseUrl = buildBaseUrl(state.port);
  if (!(await checkHealth(baseUrl))) {
    process.stdout.write(
      `OpenCode serve at ${baseUrl} is not reachable (pid ${state.pid}). Run \`check\` or \`ensure-serve\` to revive it.\n`
    );
    process.exitCode = 1;
    return;
  }

  let raw;
  try {
    raw = await listSessions(baseUrl, directory);
  } catch (error) {
    throw new Error(`Failed to list sessions: ${error.message}`);
  }

  const sessions = (Array.isArray(raw) ? raw : []).map(summarizeSession);
  let filtered = sessionFilter
    ? sessions.filter((s) => s.id === sessionFilter)
    : sessions;

  // Newest first by updatedAtMs, falling back to createdAtMs.
  filtered.sort((a, b) => {
    const av = a.updatedAtMs ?? a.createdAtMs ?? 0;
    const bv = b.updatedAtMs ?? b.createdAtMs ?? 0;
    return bv - av;
  });
  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    if (sessionFilter) {
      process.stdout.write(`No session found with id ${sessionFilter} in ${directory}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`No sessions reported by the serve at ${baseUrl}.\n`);
    return;
  }

  const cutoffMs = Date.now() - sinceMinutes * 60 * 1000;
  const lines = [
    `OpenCode sessions at ${baseUrl} (directory: ${directory})`,
    `Active threshold: updated within ${sinceMinutes} minute${sinceMinutes === 1 ? "" : "s"}.`,
    "",
    "| verdict | id | age | title |",
    "| --- | --- | --- | --- |"
  ];
  for (const s of filtered) {
    const updMs = s.updatedAtMs ?? s.createdAtMs;
    const verdict = updMs != null && updMs >= cutoffMs ? "active" : "idle";
    const age = formatRelativeAge(updMs);
    lines.push(
      `| ${verdict} | ${escapeMarkdownCell(s.id)} | ${escapeMarkdownCell(age)} | ${escapeMarkdownCell(s.summary)} |`
    );
  }
  lines.push(
    "",
    "Note: 'active' means the session was updated recently on the serve.",
    "A foreground `task` call that returned non-zero may correspond to a session that is still active here;",
    "check the verdict above before retrying so you don't double-fire a still-running session."
  );
  process.stdout.write(lines.join("\n") + "\n");
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--all"],
    stringFlags: ["--directory"]
  });
  const directory = resolveDirectory(options.directory);
  const jobId = positionals[0] ?? null;

  if (jobId) {
    const job = refreshStaleRunningJobs(directory).find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      throw new Error(`No job found for ${jobId}.`);
    }
    process.stdout.write(buildSingleJobView(job));
    return;
  }

  process.stdout.write(buildJobListView(directory, { all: Boolean(options.all) }));
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory"]
  });
  const directory = resolveDirectory(options.directory);
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for result.");
  }

  const job = readJob(directory, jobId);
  if (!job) {
    throw new Error(`No job found for ${jobId}.`);
  }

  const logText = readLogText(job.logFile);
  if (job.status === "running" || job.status === "queued") {
    process.stdout.write(`Job ${job.id} is still in progress. Showing current log.\n`);
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
    stringFlags: ["--directory"]
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
    stringFlags: ["--directory"]
  });
  const directory = resolveDirectory(options.directory);
  const state = normalizeState(readState(directory));

  if (!state) {
    process.stdout.write(renderCleanupResult(directory, { found: false }));
    return;
  }

  const wasRunning = isPidRunning(state.pid);
  if (wasRunning) {
    await terminateProcess(state.pid);
  }
  removeState(directory);

  process.stdout.write(
    renderCleanupResult(directory, {
      found: true,
      wasRunning,
      pid: state.pid,
      port: state.port
    })
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "check") {
    await handleCheck(rest);
    return;
  }
  if (command === "ensure-serve") {
    await handleEnsureServe(rest);
    return;
  }
  if (command === "task") {
    await handleTask(rest);
    return;
  }
  if (command === "review") {
    await handleReview(rest);
    return;
  }
  if (command === "status") {
    await handleStatus(rest);
    return;
  }
  if (command === "sessions") {
    await handleSessions(rest);
    return;
  }
  if (command === "result") {
    await handleResult(rest);
    return;
  }
  if (command === "cancel") {
    await handleCancel(rest);
    return;
  }
  if (command === "cleanup") {
    await handleCleanup(rest);
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
  collectBranchReviewContext,
  collectWorkingTreeReviewContext,
  generateJobId,
  formatDuration,
  isActiveJob,
  isPidRunning,
  normalizePromptText,
  parseArgs,
  parseSseBlock,
  readJobs,
  readLogTail,
  refreshStaleRunningJobs,
  renderBackgroundTaskStart,
  resolveDirectory,
  summarizePrompt,
  upsertJob
};
