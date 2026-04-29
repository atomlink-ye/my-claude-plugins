import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { MAX_STORED_JOBS, STATUS_LOG_TAIL_LINES } from "./constants.mjs";
import { jobLogFilePath, jobsFilePath } from "./config.mjs";
import { isPidRunning } from "./process-utils.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function randomSix() {
  return crypto.randomBytes(3).toString("hex");
}

export function generateJobId() {
  return `task-${randomSix()}-${randomSix()}`;
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

export function sortJobsNewestFirst(jobs) {
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

export function readJobs(directory) {
  ensureDirectoryExists(directory);
  return normalizeJobsValue(safeReadJsonFile(jobsFilePath(directory), []));
}

export function writeJobs(directory, jobs) {
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

export function upsertJob(directory, patch) {
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

export function readJob(directory, jobId) {
  return readJobs(directory).find((job) => job.id === jobId) ?? null;
}

export function isActiveJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

export function refreshStaleRunningJobs(directory) {
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

export function formatDuration(startIso, endIso = nowIso()) {
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

export function summarizePrompt(prompt) {
  const normalized = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 120)}...`;
}

export function normalizePromptText(prompt) {
  return String(prompt ?? "").trim();
}

export function readLogText(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  return fs.readFileSync(logFile, "utf8");
}

export function readLogTail(logFile, lineCount = STATUS_LOG_TAIL_LINES) {
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

export function appendLogLine(logFile, message) {
  if (!logFile || !message) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`, "utf8");
}

export function appendLogChunk(logFile, chunk) {
  if (!logFile || chunk == null) {
    return;
  }
  fs.appendFileSync(logFile, chunk, "utf8");
}

export function buildJobRecord(directory, jobId, prompt, options = {}) {
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

export function markJobRunning(directory, jobId, patch = {}) {
  return upsertJob(directory, {
    id: jobId,
    ...patch,
    status: "running",
    startedAt: patch.startedAt ?? nowIso(),
    completedAt: null,
    error: null
  });
}

export function markJobFinished(directory, jobId, status, patch = {}) {
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

export function renderBackgroundTaskStart(jobId, scriptPath, directory) {
  const script = scriptPath ?? "scripts/opencode-companion.mjs";
  // Shell-safe single-quote escaping: wrap in ' and replace internal ' with '\''
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const dirFlag = directory ? ` --directory ${sq(directory)}` : "";
  return `OpenCode task started in background as ${jobId}. Check status: node ${sq(script)} job status ${jobId}${dirFlag}\n`;
}

export function createJobLogFile(directory, jobId) {
  const logFile = jobLogFilePath(directory, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

export function spawnBackgroundTaskWorker(entryScriptPath, directory, jobId, prompt, args = {}) {
  if (!path.isAbsolute(entryScriptPath)) {
    throw new Error(`Background worker entry script path must be absolute: ${entryScriptPath}`);
  }

  const childArgs = [entryScriptPath, "session", "new", "--job-id", jobId, "--directory", directory];

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
