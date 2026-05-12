import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { MAX_STORED_JOBS, STATUS_LOG_TAIL_LINES } from "./constants.mjs";
import {
  jobCompatLogFilePath,
  jobDirectoryPath,
  jobEventsFilePath,
  jobPromptFilePath,
  jobsFilePath,
  jobSnapshotMarkdownFilePath,
  jobSnapshotStateFilePath,
  legacyJobsFilePath,
  promptInlineMaxBytes,
  resolveArtifactRoot
} from "./config.mjs";
import { isPidRunning } from "./process-utils.mjs";

const MAX_SNAPSHOT_TRACE_ENTRIES = 12;

export function nowIso() {
  return new Date().toISOString();
}

export function randomSix() {
  return crypto.randomBytes(3).toString("hex");
}

export function generateJobId() {
  return `task-${randomSix()}-${randomSix()}`;
}

function parseSnapshotTimestamp(value) {
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

function padTimestampPart(value) {
  return String(value).padStart(2, "0");
}

function formatSnapshotTimestamp(value) {
  if (value == null) {
    return "-";
  }
  const parsed = parseSnapshotTimestamp(value);
  if (!Number.isFinite(parsed)) {
    return String(value);
  }
  const date = new Date(parsed);
  return [
    date.getFullYear(),
    padTimestampPart(date.getMonth() + 1),
    padTimestampPart(date.getDate())
  ].join("-") + ` ${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}:${padTimestampPart(date.getSeconds())}`;
}

function ensureDirectoryExists(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stats = fs.statSync(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
}

function ensureParentDirectory(filePath) {
  ensureDirectoryExists(path.dirname(filePath));
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

function writeJsonAtomic(filePath, value) {
  ensureParentDirectory(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeTextAtomic(filePath, text) {
  ensureParentDirectory(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
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

function resolveJobPaths(directory, jobId, artifactRoot = null) {
  const resolvedArtifactRoot = resolveArtifactRoot(directory, artifactRoot);
  return {
    artifactRoot: resolvedArtifactRoot,
    jobDir: jobDirectoryPath(directory, jobId, resolvedArtifactRoot),
    logFile: jobCompatLogFilePath(directory, jobId, resolvedArtifactRoot),
    eventsFile: jobEventsFilePath(directory, jobId, resolvedArtifactRoot),
    snapshotFile: jobSnapshotStateFilePath(directory, jobId, resolvedArtifactRoot),
    snapshotMarkdownFile: jobSnapshotMarkdownFilePath(directory, jobId, resolvedArtifactRoot),
    promptFile: jobPromptFilePath(directory, jobId, resolvedArtifactRoot)
  };
}

function ensureJobArtifacts(directory, jobId, artifactRoot = null) {
  const paths = resolveJobPaths(directory, jobId, artifactRoot);
  ensureDirectoryExists(paths.jobDir);
  ensureParentDirectory(jobsFilePath(directory, artifactRoot));
  return paths;
}

function normalizeTraceEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const label = String(entry.label ?? "").trim();
  const text = String(entry.text ?? "").trim();
  const detailLines = Array.isArray(entry.detailLines)
    ? entry.detailLines.map((line) => String(line ?? "").trim()).filter(Boolean)
    : [];
  if (!label && !text && detailLines.length === 0) {
    return null;
  }
  return {
    type: String(entry.type ?? "trace").trim() || "trace",
    sessionId: entry.sessionId ? String(entry.sessionId).trim() : null,
    label: label || "trace",
    text,
    detailLines,
    at: String(entry.at ?? nowIso())
  };
}

function normalizeSnapshot(snapshot = {}) {
  return {
    jobId: snapshot.jobId ?? "",
    directory: snapshot.directory ?? "",
    artifactRoot: snapshot.artifactRoot ?? "",
    jobDir: snapshot.jobDir ?? "",
    promptSummary: snapshot.promptSummary ?? "",
    status: snapshot.status ?? "queued",
    model: snapshot.model ?? null,
    pid: snapshot.pid ?? null,
    sessionId: snapshot.sessionId ?? null,
    startedAt: snapshot.startedAt ?? null,
    completedAt: snapshot.completedAt ?? null,
    createdAt: snapshot.createdAt ?? nowIso(),
    updatedAt: snapshot.updatedAt ?? nowIso(),
    latestActivity: snapshot.latestActivity ?? {
      at: snapshot.startedAt ?? snapshot.updatedAt ?? nowIso(),
      kind: "job_created",
      sessionId: snapshot.sessionId ?? null,
      summary: snapshot.promptSummary ?? "Job created"
    },
    active: {
      descendantSessionIds: Array.isArray(snapshot.active?.descendantSessionIds)
        ? [...new Set(snapshot.active.descendantSessionIds.map((entry) => String(entry).trim()).filter(Boolean))]
        : [],
      toolHints: Array.isArray(snapshot.active?.toolHints)
        ? [...new Set(snapshot.active.toolHints.map((entry) => String(entry).trim()).filter(Boolean))]
        : []
    },
    hints: {
      stale: Boolean(snapshot.hints?.stale),
      blocked: Boolean(snapshot.hints?.blocked),
      interventionNeeded: Boolean(snapshot.hints?.interventionNeeded),
      reason: snapshot.hints?.reason ? String(snapshot.hints.reason) : null
    },
    verdict: snapshot.verdict ?? null,
    recommendedAction: snapshot.recommendedAction ?? null,
    hierarchy: snapshot.hierarchy && typeof snapshot.hierarchy === "object"
      ? {
          rootSessionId: snapshot.hierarchy.rootSessionId ?? null,
          verdict: snapshot.hierarchy.verdict ?? null,
          sessionCount: snapshot.hierarchy.sessionCount ?? null,
          descendantCount: snapshot.hierarchy.descendantCount ?? null,
          statusCounts: snapshot.hierarchy.statusCounts ?? null,
          latestActivityAt: snapshot.hierarchy.latestActivityAt ?? null,
          latestActivitySessionId: snapshot.hierarchy.latestActivitySessionId ?? null
        }
      : null,
    final: snapshot.final && typeof snapshot.final === "object"
      ? {
          status: snapshot.final.status ?? null,
          completionMode: snapshot.final.completionMode ?? null,
          rawSessionStatus: snapshot.final.rawSessionStatus ?? null,
          hierarchyVerdict: snapshot.final.hierarchyVerdict ?? null,
          combinedText: snapshot.final.combinedText ?? "",
          summary: snapshot.final.summary ?? "",
          error: snapshot.final.error ?? null
        }
      : {
          status: null,
          completionMode: null,
          rawSessionStatus: null,
          hierarchyVerdict: null,
          combinedText: "",
          summary: "",
          error: null
        },
    recentTrace: Array.isArray(snapshot.recentTrace)
      ? snapshot.recentTrace.map(normalizeTraceEntry).filter(Boolean).slice(-MAX_SNAPSHOT_TRACE_ENTRIES)
      : []
  };
}

function summarizeFinalText(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.split(/\r?\n/).find(Boolean)?.trim() ?? normalized;
}

function deriveSnapshotVerdict(snapshot) {
  if (snapshot.hints.interventionNeeded) {
    return "intervention-needed";
  }
  if (snapshot.hints.blocked) {
    return "blocked";
  }
  if (snapshot.hints.stale) {
    return "stale";
  }
  if (["failed", "cancelled"].includes(snapshot.status)) {
    return "failed";
  }
  if (["completed", "delegated"].includes(snapshot.status)) {
    return "complete";
  }
  return "healthy";
}

function deriveSnapshotRecommendedAction(snapshot) {
  if (snapshot.hints.interventionNeeded) {
    return "intervene now";
  }
  if (snapshot.hints.blocked) {
    return "inspect blockers before waiting again";
  }
  if (snapshot.hints.stale) {
    return "inspect artifacts or session status before waiting longer";
  }
  if (["completed", "delegated"].includes(snapshot.status)) {
    return "read final result";
  }
  if (["failed", "cancelled"].includes(snapshot.status)) {
    return "inspect final error and artifacts";
  }
  return "keep waiting";
}

function deriveCurrentFocus(snapshot) {
  if (snapshot.active.toolHints.length > 0) {
    return snapshot.active.toolHints.join(", ");
  }
  if (snapshot.active.descendantSessionIds.length > 0) {
    return `active descendant sessions: ${snapshot.active.descendantSessionIds.join(", ")}`;
  }
  if (snapshot.hints.reason) {
    return snapshot.hints.reason;
  }
  return snapshot.final.summary || snapshot.latestActivity.summary || "none reported";
}

function formatStatusCounts(statusCounts) {
  if (!statusCounts || typeof statusCounts !== "object") {
    return "-";
  }
  return Object.entries(statusCounts)
    .filter(([, count]) => Number(count) > 0)
    .map(([status, count]) => `${status}:${count}`)
    .join(", ") || "-";
}

function renderTraceMarkdown(traceEntries = []) {
  if (!Array.isArray(traceEntries) || traceEntries.length === 0) {
    return "";
  }
  const lines = ["## Recent execution trace", ""];
  for (const entry of traceEntries) {
    lines.push(`- ${entry.label}`);
    if (entry.text) {
      lines.push(`  ${entry.text.replace(/\n/g, "\n  ")}`);
    }
    for (const detailLine of entry.detailLines ?? []) {
      lines.push(`  ${detailLine.replace(/\n/g, "\n  ")}`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobSnapshotMarkdown(snapshotInput, { verbose = false } = {}) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const lines = [
    "# OpenCode Job Status",
    "",
    `Job ID: ${snapshot.jobId}`,
    `Status: ${snapshot.status}`,
    `Verdict: ${snapshot.verdict ?? deriveSnapshotVerdict(snapshot)}`,
    `Recommended action: ${snapshot.recommendedAction ?? deriveSnapshotRecommendedAction(snapshot)}`,
    `Latest activity: ${formatSnapshotTimestamp(snapshot.latestActivity.at)}`,
    `Latest activity kind: ${snapshot.latestActivity.kind ?? "-"}`,
    `Latest activity session: ${snapshot.latestActivity.sessionId ?? "-"}`,
    `Current focus: ${deriveCurrentFocus(snapshot)}`
  ];

  if (snapshot.hints.reason) {
    lines.push(`Hint: ${snapshot.hints.reason}`);
  }
  if (snapshot.hierarchy) {
    lines.push(`Hierarchy verdict: ${snapshot.hierarchy.verdict ?? "-"}`);
    lines.push(`Hierarchy statuses: ${formatStatusCounts(snapshot.hierarchy.statusCounts)}`);
  }
  if (snapshot.final.summary) {
    lines.push(`Final result: ${snapshot.final.summary}`);
  }
  if (snapshot.final.error) {
    lines.push(`Final error: ${snapshot.final.error}`);
  }
  if (snapshot.status === "delegated") {
    lines.push("Delegation to subagents is normal.");
    if (snapshot.sessionId) {
      lines.push(`Suggested follow-up: session status ${snapshot.sessionId} or session attach ${snapshot.sessionId}`);
    }
  }

  if (!verbose) {
    return `${lines.join("\n")}\n`;
  }

  if (snapshot.hierarchy) {
    lines.push(
      "",
      "## Session Hierarchy",
      "",
      `- root session: ${snapshot.hierarchy.rootSessionId ?? "-"}`,
      `- hierarchy verdict: ${snapshot.hierarchy.verdict ?? "-"}`,
      `- session count: ${snapshot.hierarchy.sessionCount ?? "-"}`,
      `- descendant count: ${snapshot.hierarchy.descendantCount ?? "-"}`,
      `- latest hierarchy activity: ${formatSnapshotTimestamp(snapshot.hierarchy.latestActivityAt)}`,
      `- latest hierarchy session: ${snapshot.hierarchy.latestActivitySessionId ?? "-"}`
    );
  }

  const traceMarkdown = renderTraceMarkdown(snapshot.recentTrace).trimEnd();
  if (traceMarkdown) {
    lines.push("", traceMarkdown);
  }

  return `${lines.join("\n")}\n`;
}

function createJobSnapshot(job) {
  const snapshot = normalizeSnapshot({
    jobId: job.id,
    directory: job.directory,
    artifactRoot: job.artifactRoot,
    jobDir: job.jobDir,
    promptSummary: job.promptSummary,
    status: job.status,
    model: job.model,
    pid: job.pid,
    sessionId: job.sessionId,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt ?? nowIso(),
    updatedAt: job.updatedAt ?? nowIso(),
    latestActivity: {
      at: job.startedAt ?? job.updatedAt ?? nowIso(),
      kind: `job_${job.status ?? "queued"}`,
      sessionId: job.sessionId ?? null,
      summary: job.promptSummary || job.error || "Job created"
    },
    final: job.error ? { error: job.error } : undefined
  });
  snapshot.verdict = deriveSnapshotVerdict(snapshot);
  snapshot.recommendedAction = deriveSnapshotRecommendedAction(snapshot);
  return snapshot;
}

function applyEventToSnapshot(snapshotInput, event) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const at = String(event.at ?? nowIso());

  snapshot.updatedAt = at;
  if (event.status != null) {
    snapshot.status = String(event.status);
  }
  if (event.startedAt != null) {
    snapshot.startedAt = event.startedAt;
  }
  if (event.completedAt != null) {
    snapshot.completedAt = event.completedAt;
  }
  if (event.model != null) {
    snapshot.model = event.model;
  }
  if (event.pid !== undefined) {
    snapshot.pid = event.pid;
  }
  if (event.sessionId != null) {
    snapshot.sessionId = event.sessionId;
  }

  const latestSummary = event.summary || event.message || event.final?.summary || event.final?.combinedText || snapshot.latestActivity.summary;
  snapshot.latestActivity = {
    at,
    kind: event.activityKind ?? event.type ?? snapshot.latestActivity.kind ?? "activity",
    sessionId: event.sessionId ?? snapshot.sessionId ?? snapshot.latestActivity.sessionId ?? null,
    summary: String(latestSummary ?? "").trim() || snapshot.latestActivity.summary || "activity"
  };

  if (event.active && typeof event.active === "object") {
    if (Array.isArray(event.active.descendantSessionIds)) {
      snapshot.active.descendantSessionIds = [...new Set(event.active.descendantSessionIds.map((entry) => String(entry).trim()).filter(Boolean))];
    }
    if (Array.isArray(event.active.toolHints)) {
      snapshot.active.toolHints = [...new Set(event.active.toolHints.map((entry) => String(entry).trim()).filter(Boolean))];
    }
  }

  if (event.hints && typeof event.hints === "object") {
    snapshot.hints = {
      stale: Boolean(event.hints.stale ?? snapshot.hints.stale),
      blocked: Boolean(event.hints.blocked ?? snapshot.hints.blocked),
      interventionNeeded: Boolean(event.hints.interventionNeeded ?? snapshot.hints.interventionNeeded),
      reason: event.hints.reason != null ? String(event.hints.reason) : snapshot.hints.reason
    };
  }

  if (event.hierarchy && typeof event.hierarchy === "object") {
    snapshot.hierarchy = {
      ...(snapshot.hierarchy ?? {}),
      rootSessionId: event.hierarchy.rootSessionId ?? snapshot.hierarchy?.rootSessionId ?? null,
      verdict: event.hierarchy.verdict ?? snapshot.hierarchy?.verdict ?? null,
      sessionCount: event.hierarchy.sessionCount ?? snapshot.hierarchy?.sessionCount ?? null,
      descendantCount: event.hierarchy.descendantCount ?? snapshot.hierarchy?.descendantCount ?? null,
      statusCounts: event.hierarchy.statusCounts ?? snapshot.hierarchy?.statusCounts ?? null,
      latestActivityAt: event.hierarchy.latestActivityAt ?? snapshot.hierarchy?.latestActivityAt ?? null,
      latestActivitySessionId: event.hierarchy.latestActivitySessionId ?? snapshot.hierarchy?.latestActivitySessionId ?? null
    };
  }

  if (event.final && typeof event.final === "object") {
    const combinedText = String(event.final.combinedText ?? snapshot.final.combinedText ?? "");
    snapshot.final = {
      status: event.final.status ?? event.status ?? snapshot.final.status ?? null,
      completionMode: event.final.completionMode ?? snapshot.final.completionMode ?? null,
      rawSessionStatus: event.final.rawSessionStatus ?? snapshot.final.rawSessionStatus ?? null,
      hierarchyVerdict: event.final.hierarchyVerdict ?? snapshot.final.hierarchyVerdict ?? null,
      combinedText,
      summary: event.final.summary ?? summarizeFinalText(combinedText) ?? snapshot.final.summary ?? "",
      error: event.final.error ?? snapshot.final.error ?? null
    };
  }

  const traceEntry = normalizeTraceEntry(event.traceEntry);
  if (traceEntry) {
    snapshot.recentTrace = [...snapshot.recentTrace, traceEntry].slice(-MAX_SNAPSHOT_TRACE_ENTRIES);
  }

  snapshot.verdict = event.verdict ?? deriveSnapshotVerdict(snapshot);
  snapshot.recommendedAction = event.recommendedAction ?? deriveSnapshotRecommendedAction(snapshot);

  return snapshot;
}

function appendEvent(filePath, event) {
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
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

function readLegacyJobs(directory) {
  const legacyFile = legacyJobsFilePath(directory);
  return normalizeJobsValue(safeReadJsonFile(legacyFile, []));
}

export function readJobs(directory, options = {}) {
  ensureDirectoryExists(directory);
  const indexPath = jobsFilePath(directory, options.artifactRoot ?? null);
  if (fs.existsSync(indexPath)) {
    return normalizeJobsValue(safeReadJsonFile(indexPath, []));
  }
  return readLegacyJobs(directory);
}

export function writeJobs(directory, jobs, options = {}) {
  ensureDirectoryExists(directory);
  const previousJobs = readJobs(directory, options);
  const nextJobs = pruneOldJobs(jobs);
  const nextJobIds = new Set(nextJobs.map((job) => job.id));

  for (const job of previousJobs) {
    if (!nextJobIds.has(job.id)) {
      removeFileIfExists(job.jobDir || jobDirectoryPath(directory, job.id, job.artifactRoot ?? options.artifactRoot ?? null));
    }
  }

  writeJsonAtomic(jobsFilePath(directory, options.artifactRoot ?? null), nextJobs);
  return nextJobs;
}

export function upsertJob(directory, patch, options = {}) {
  const artifactRoot = patch.artifactRoot ?? options.artifactRoot ?? null;
  const jobs = readJobs(directory, { artifactRoot });
  const now = nowIso();
  const existingIndex = jobs.findIndex((job) => job.id === patch.id);
  const paths = patch.id ? ensureJobArtifacts(directory, patch.id, artifactRoot) : null;
  const nextRecord = normalizeJobRecord(
    existingIndex === -1
      ? {
          createdAt: now,
          updatedAt: now,
          ...patch,
          ...(paths ?? {})
        }
      : {
          ...jobs[existingIndex],
          ...patch,
          ...(paths ?? {}),
          updatedAt: now
        },
    directory,
    artifactRoot
  );

  if (existingIndex === -1) {
    jobs.unshift(nextRecord);
  } else {
    jobs[existingIndex] = nextRecord;
  }

  writeJobs(directory, jobs, { artifactRoot: nextRecord.artifactRoot });

  if (!fs.existsSync(nextRecord.snapshotFile)) {
    writeJobSnapshot(nextRecord.snapshotFile, createJobSnapshot(nextRecord));
  }
  return nextRecord;
}

function normalizeJobRecord(job, directory, artifactRoot = null) {
  const resolvedArtifactRoot = job.artifactRoot ?? resolveArtifactRoot(directory, artifactRoot);
  const paths = resolveJobPaths(directory, job.id, resolvedArtifactRoot);
  return {
    ...job,
    directory,
    artifactRoot: resolvedArtifactRoot,
    jobDir: job.jobDir ?? paths.jobDir,
    logFile: job.logFile ?? paths.logFile,
    eventsFile: job.eventsFile ?? paths.eventsFile,
    snapshotFile: job.snapshotFile ?? paths.snapshotFile,
    snapshotMarkdownFile: job.snapshotMarkdownFile ?? paths.snapshotMarkdownFile,
    promptFile: job.promptFile ?? paths.promptFile
  };
}

export function readJob(directory, jobId, options = {}) {
  return readJobs(directory, options).find((job) => job.id === jobId) ?? null;
}

export function readJobSnapshot(directory, jobId, options = {}) {
  const existing = readJob(directory, jobId, options);
  const artifactRoot = options.artifactRoot ?? existing?.artifactRoot ?? null;
  const snapshotFile = existing?.snapshotFile ?? jobSnapshotStateFilePath(directory, jobId, artifactRoot);
  if (!fs.existsSync(snapshotFile)) {
    return existing ? createJobSnapshot(existing) : null;
  }
  return normalizeSnapshot(safeReadJsonFile(snapshotFile, null));
}

function writeJobSnapshot(snapshotFile, snapshot) {
  writeJsonAtomic(snapshotFile, snapshot);
  const markdownFile = jobSnapshotMarkdownFilePath(snapshot.directory, snapshot.jobId, snapshot.artifactRoot);
  writeTextAtomic(markdownFile, renderJobSnapshotMarkdown(snapshot));
}

export function isActiveJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

export function refreshStaleRunningJobs(directory, options = {}) {
  const jobs = readJobs(directory, options);
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
      const failed = {
        ...job,
        status: "failed",
        completedAt,
        pid: null,
        error: "Worker process died unexpectedly",
        updatedAt: completedAt
      };
      recordJobEvent(directory, job.id, {
        type: "job.lifecycle",
        at: completedAt,
        status: "failed",
        summary: "Worker process died unexpectedly",
        completedAt,
        pid: null,
        final: { error: "Worker process died unexpectedly", status: "failed" },
        hints: { blocked: true, reason: "Worker process died unexpectedly" }
      }, { artifactRoot: job.artifactRoot });
      return failed;
    }

    const hasPid = Number.isInteger(job.pid) && job.pid > 0;
    if (hasPid) {
      if (isPidRunning(job.pid)) {
        return job;
      }

      changed = true;
      const failed = {
        ...job,
        status: "failed",
        completedAt,
        pid: null,
        error: "Worker process died unexpectedly",
        updatedAt: completedAt
      };
      recordJobEvent(directory, job.id, {
        type: "job.lifecycle",
        at: completedAt,
        status: "failed",
        summary: "Worker process died unexpectedly",
        completedAt,
        pid: null,
        final: { error: "Worker process died unexpectedly", status: "failed" },
        hints: { blocked: true, reason: "Worker process died unexpectedly" }
      }, { artifactRoot: job.artifactRoot });
      return failed;
    }

    const startedAtMs = Date.parse(job.startedAt ?? "");
    if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs <= staleQueuedMs) {
      return job;
    }

    changed = true;
    const failed = {
      ...job,
      status: "failed",
      completedAt,
      pid: null,
      error: "Worker process died unexpectedly",
      updatedAt: completedAt
    };
    recordJobEvent(directory, job.id, {
      type: "job.lifecycle",
      at: completedAt,
      status: "failed",
      summary: "Worker process died unexpectedly",
      completedAt,
      pid: null,
      final: { error: "Worker process died unexpectedly", status: "failed" },
      hints: { blocked: true, reason: "Worker process died unexpectedly" }
    }, { artifactRoot: job.artifactRoot });
    return failed;
  });

  if (changed) {
    writeJobs(directory, nextJobs, options);
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
  ensureParentDirectory(logFile);
  fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`, "utf8");
}

export function appendLogChunk(logFile, chunk) {
  if (!logFile || chunk == null) {
    return;
  }
  ensureParentDirectory(logFile);
  fs.appendFileSync(logFile, chunk, "utf8");
}

export function buildJobRecord(directory, jobId, prompt, options = {}) {
  const promptText = normalizePromptText(prompt);
  const paths = ensureJobArtifacts(directory, jobId, options.artifactRoot ?? null);
  const artifactRoot = resolveArtifactRoot(directory, options.artifactRoot ?? null);
  return normalizeJobRecord({
    id: jobId,
    status: options.status ?? "queued",
    prompt: promptText,
    promptSummary: summarizePrompt(promptText),
    startedAt: options.startedAt ?? null,
    completedAt: options.completedAt ?? null,
    directory,
    model: options.model ?? null,
    pid: options.pid ?? null,
    sessionId: options.sessionId ?? null,
    error: options.error ?? null,
    artifactRoot,
    createdAt: options.createdAt ?? nowIso(),
    updatedAt: options.updatedAt ?? nowIso(),
    ...paths
  }, directory, artifactRoot);
}

export function recordJobEvent(directory, jobId, event, options = {}) {
  const existing = readJob(directory, jobId, options);
  const artifactRoot = options.artifactRoot ?? existing?.artifactRoot ?? null;
  const job = existing ?? buildJobRecord(directory, jobId, "", { artifactRoot });
  const paths = ensureJobArtifacts(directory, jobId, artifactRoot);
  const snapshotBase = readJobSnapshot(directory, jobId, { artifactRoot }) ?? createJobSnapshot({ ...job, ...paths });
  const normalizedEvent = {
    at: event.at ?? nowIso(),
    type: event.type ?? "job.activity",
    ...event
  };
  appendEvent(paths.eventsFile, normalizedEvent);
  const snapshot = applyEventToSnapshot({ ...snapshotBase, snapshotMarkdownFile: paths.snapshotMarkdownFile }, normalizedEvent);
  writeJsonAtomic(paths.snapshotFile, snapshot);
  writeTextAtomic(paths.snapshotMarkdownFile, renderJobSnapshotMarkdown(snapshot));
  return snapshot;
}

export function markJobRunning(directory, jobId, patch = {}, options = {}) {
  const job = upsertJob(directory, {
    id: jobId,
    ...patch,
    status: "running",
    startedAt: patch.startedAt ?? nowIso(),
    completedAt: null,
    error: null
  }, options);
  recordJobEvent(directory, jobId, {
    type: "job.lifecycle",
    status: "running",
    startedAt: job.startedAt,
    sessionId: patch.sessionId ?? job.sessionId,
    model: patch.model ?? job.model,
    pid: patch.pid ?? job.pid,
    summary: "Background worker running",
    activityKind: "worker_running"
  }, { artifactRoot: job.artifactRoot });
  return job;
}

export function markJobFinished(directory, jobId, status, patch = {}, options = {}) {
  const current = readJob(directory, jobId, options);
  if (current?.status === "cancelled") {
    return current;
  }

  const job = upsertJob(directory, {
    id: jobId,
    ...patch,
    status,
    completedAt: patch.completedAt ?? nowIso(),
    pid: null
  }, { artifactRoot: patch.artifactRoot ?? current?.artifactRoot ?? options.artifactRoot ?? null });

  recordJobEvent(directory, jobId, {
    type: "job.lifecycle",
    status,
    completedAt: job.completedAt,
    sessionId: patch.sessionId ?? job.sessionId,
    model: patch.model ?? job.model,
    summary:
      patch.error
        ? patch.error
        : status === "completed"
          ? "Job completed"
          : status === "delegated"
            ? "Delegated work settled"
            : status === "cancelled"
              ? "Job cancelled"
              : "Job finished",
    activityKind: `job_${status}`,
    final: patch.final ?? {
      status,
      error: patch.error ?? null
    },
    hints: patch.error ? { blocked: true, reason: patch.error } : undefined
  }, { artifactRoot: job.artifactRoot });
  return job;
}

export function renderBackgroundTaskStart(jobId, scriptPath, directory, artifactRoot = null) {
  const script = scriptPath ?? "scripts/opencode-companion.mjs";
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const dirFlag = directory ? ` --directory ${sq(directory)}` : "";
  const artifactFlag = artifactRoot ? ` --artifact-root ${sq(artifactRoot)}` : "";
  return `OpenCode task started in background as ${jobId}. Check status: node ${sq(script)} job status ${jobId}${dirFlag}${artifactFlag}\n`;
}

export function createJobLogFile(directory, jobId, options = {}) {
  const paths = ensureJobArtifacts(directory, jobId, options.artifactRoot ?? null);
  if (!fs.existsSync(paths.logFile)) {
    fs.writeFileSync(paths.logFile, "", "utf8");
  }
  if (!fs.existsSync(paths.snapshotFile)) {
    const base = createJobSnapshot(buildJobRecord(directory, jobId, "", { artifactRoot: options.artifactRoot ?? null }));
    writeJsonAtomic(paths.snapshotFile, base);
    writeTextAtomic(paths.snapshotMarkdownFile, renderJobSnapshotMarkdown(base));
  }
  return paths.logFile;
}

export function spawnBackgroundTaskWorker(entryScriptPath, directory, jobId, prompt, args = {}) {
  if (!path.isAbsolute(entryScriptPath)) {
    throw new Error(`Background worker entry script path must be absolute: ${entryScriptPath}`);
  }

  const childArgs = [entryScriptPath, "session", "new", "--job-id", jobId, "--directory", directory];

  if (args.serverDirectory) {
    childArgs.push("--server-directory", args.serverDirectory);
  }
  if (args.artifactRoot) {
    childArgs.push("--artifact-root", args.artifactRoot);
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

  const promptBytes = Buffer.byteLength(prompt ?? "", "utf8");
  const inlineMaxBytes = promptInlineMaxBytes();
  let promptFile = null;
  if (promptBytes > inlineMaxBytes) {
    promptFile = jobPromptFilePath(directory, jobId, args.artifactRoot ?? null);
    ensureParentDirectory(promptFile);
    fs.writeFileSync(promptFile, String(prompt ?? ""), "utf8");
    childArgs.push("--prompt-file", promptFile);
  } else {
    childArgs.push("--", prompt);
  }

  const logFile = createJobLogFile(directory, jobId, { artifactRoot: args.artifactRoot ?? null });
  const logFd = fs.openSync(logFile, "a");

  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
  } catch (error) {
    fs.closeSync(logFd);
    if (promptFile) {
      try { fs.unlinkSync(promptFile); } catch {}
    }
    throw error;
  }

  fs.closeSync(logFd);

  return child;
}
