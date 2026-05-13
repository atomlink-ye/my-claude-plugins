#!/usr/bin/env node

import fs from "node:fs";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SESSION_TIMEOUT_MINS,
  MESSAGE_POST_TIMEOUT_MS,
  STATUS_LOG_TAIL_LINES,
  STATUS_RECENT_LIMIT,
  STATUS_SESSION_LIMIT
} from "./opencode-companion/constants.mjs";
import {
  parseArgs,
  readEnvDurationMs,
  resolveDirectory,
  resolveServerDirectory,
  stateFilePath
} from "./opencode-companion/config.mjs";
import {
  checkHealth,
  isAbortError,
  openEventStream,
  requestJson
} from "./opencode-companion/http-client.mjs";
import {
  delay,
  isPidRunning,
  log,
  stderr,
  terminateProcess
} from "./opencode-companion/process-utils.mjs";
import {
  appendLogLine,
  buildJobRecord,
  createJobLogFile,
  formatDuration,
  generateJobId,
  isActiveJob,
  markJobFinished,
  markJobRunning,
  normalizePromptText,
  nowIso,
  readJob,
  readJobSnapshot,
  readJobs,
  readLogText,
  readLogTail,
  recordJobEvent,
  refreshStaleRunningJobs,
  renderBackgroundTaskStart,
  renderJobSnapshotMarkdown,
  sortJobsNewestFirst,
  spawnBackgroundTaskWorker,
  summarizePrompt,
  upsertJob
} from "./opencode-companion/jobs.mjs";
import {
  buildBaseUrl,
  ensureManagedServe,
  ensureOpencodeInstalled,
  normalizeState,
  readState,
  removeState
} from "./opencode-companion/serve.mjs";
import {
  buildReviewPrompt,
  collectBranchReviewContext,
  collectWorkingTreeReviewContext,
  getAheadCommitCount,
  getCurrentGitBranch,
  normalizeReviewScope,
  resolveDefaultReviewBaseRef
} from "./opencode-companion/review.mjs";
import { parseSseBlock, streamSseResponse } from "./opencode-companion/sse.mjs";

const USAGE_LINES = {
  "serve start": "node scripts/opencode-companion.mjs serve start [--port N] [--server-directory SERVER_DIR]",
  "serve status": "node scripts/opencode-companion.mjs serve status [--server-directory SERVER_DIR]",
  "serve stop": "node scripts/opencode-companion.mjs serve stop [--server-directory SERVER_DIR]",
  "session new": "node scripts/opencode-companion.mjs session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- \"PROMPT\"]",
  "session continue": "node scripts/opencode-companion.mjs session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- \"PROMPT\"]",
  "session attach": "node scripts/opencode-companion.mjs session attach <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]",
  "session wait": "node scripts/opencode-companion.mjs session wait <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]",
  "session list": "node scripts/opencode-companion.mjs session list [--directory WORK_DIR] [--server-directory SERVER_DIR]",
  "session status": "node scripts/opencode-companion.mjs session status <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]",
  "job list": "node scripts/opencode-companion.mjs job list [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--all] [--verbose]",
  "job status": "node scripts/opencode-companion.mjs job status <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--verbose]",
  "job wait": "node scripts/opencode-companion.mjs job wait <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--timeout MINS] [--verbose]",
  "job result": "node scripts/opencode-companion.mjs job result <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH] [--verbose]",
  "job cancel": "node scripts/opencode-companion.mjs job cancel <job-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--artifact-root PATH]",
  "review": "node scripts/opencode-companion.mjs review [--scope SCOPE] [--base REF] [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--timeout MINS] [--wait] [--background] [--adversarial] [-- \"FOCUS\"]"
};

const USAGE_GROUPS = {
  root: [
    "serve start",
    "serve status",
    "serve stop",
    "session new",
    "session continue",
    "session attach",
    "session wait",
    "session list",
    "session status",
    "job list",
    "job status",
    "job wait",
    "job result",
    "job cancel",
    "review"
  ],
  serve: ["serve start", "serve status", "serve stop"],
  session: ["session new", "session continue", "session attach", "session wait", "session list", "session status"],
  job: ["job list", "job status", "job wait", "job result", "job cancel"],
  review: ["review"]
};

function hasHelpFlag(argv) {
  for (const token of argv) {
    if (token === "--") {
      return false;
    }
    if (token === "--help" || token === "-h") {
      return true;
    }
  }
  return false;
}

function printUsage(topic = "root") {
  const usageKeys = USAGE_GROUPS[topic] ?? [topic];
  const lines = ["Usage:"];
  for (const usageKey of usageKeys) {
    const usageLine = USAGE_LINES[usageKey];
    if (usageLine) {
      lines.push(`  ${usageLine}`);
    }
  }
  lines.push(
    "",
    `  Default session timeout: ${DEFAULT_SESSION_TIMEOUT_MINS} minutes`,
    "  Add --help after any command path for scoped help.",
    "  SERVER_DIR: where .opencode-serve.json lives (default: ~)",
    "  WORK_DIR:   project working directory sent to OpenCode sessions (default: $CLAUDE_PROJECT_DIR or cwd)"
  );
  process.stdout.write(`${lines.join("\n")}\n`);
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

function readHierarchyPendingGraceMs() {
  const forceQuiescenceTimeoutMs = readEnvDurationMs("OPENCODE_FORCE_QUIESCENCE_TIMEOUT_MS", 30000);
  return Math.max(
    forceQuiescenceTimeoutMs,
    readEnvDurationMs("OPENCODE_HIERARCHY_PENDING_GRACE_MS", 300000)
  );
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
    `- latest activity: ${formatReadableTimestamp(metadata.subtreeSummary.latestActivityLabel) || "-"}`,
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
      `| ${escapeTableCell(job.id)} | ${escapeTableCell(job.status ?? "")} | ${escapeTableCell(job.sessionId ?? "")} | ${escapeTableCell(hierarchyMetadata?.rootSessionId ?? "")} | ${escapeTableCell(hierarchyMetadata?.hierarchyVerdict ?? "")} | ${escapeTableCell(hierarchyMetadata ? `${hierarchyMetadata.subtreeSummary.sessionCount} / ${formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts)}` : "") } | ${escapeTableCell(formatReadableTimestamp(job.startedAt ?? ""))} | ${escapeTableCell(job.elapsed ?? "")} | ${escapeTableCell(job.model ?? "")} | ${escapeTableCell(job.promptSummary ?? "")} | ${escapeTableCell(job.pid ?? "")} |`
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
    `| started | ${escapeTableCell(formatReadableTimestamp(job.startedAt ?? ""))} |`,
    `| elapsed | ${escapeTableCell(job.elapsed ?? "")} |`,
    `| model | ${escapeTableCell(job.model ?? "")} |`,
    `| pid | ${escapeTableCell(job.pid ?? "")} |`,
    `| sessionId | ${escapeTableCell(job.sessionId ?? "")} |`,
    `| root session | ${escapeTableCell(hierarchyMetadata?.rootSessionId ?? "")} |`,
    `| current observed session status | ${escapeTableCell(hierarchyMetadata?.currentSessionObservedStatus ?? "")} |`,
    `| hierarchy verdict | ${escapeTableCell(hierarchyMetadata?.hierarchyVerdict ?? "")} |`,
    `| hierarchy size | ${escapeTableCell(hierarchyMetadata?.subtreeSummary.sessionCount ?? "")} |`,
    `| hierarchy statuses | ${escapeTableCell(hierarchyMetadata ? formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts) : "")} |`,
    `| hierarchy latest activity | ${escapeTableCell(formatReadableTimestamp(hierarchyMetadata?.subtreeSummary.latestActivityLabel ?? ""))} |`,
    `| hierarchy latest activity session | ${escapeTableCell(hierarchyMetadata?.subtreeSummary.latestActivitySessionId ?? "")} |`,
    `| prompt | ${escapeTableCell(job.prompt ?? job.promptSummary ?? "")} |`,
    `| log file | ${escapeTableCell(job.logFile ?? "")} |`
  ];

  if (job.completedAt) {
    lines.push(`| completed | ${escapeTableCell(formatReadableTimestamp(job.completedAt))} |`);
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

function buildJobListView(directory, options = {}) {
  const jobs = sortJobsNewestFirst(refreshStaleRunningJobs(directory, { artifactRoot: options.artifactRoot ?? null }));
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
        lines.push(`  Hierarchy: root ${hierarchyMetadata.rootSessionId} | verdict ${hierarchyMetadata.hierarchyVerdict} | sessions ${hierarchyMetadata.subtreeSummary.sessionCount} | ${formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts)} | latest ${formatReadableTimestamp(hierarchyMetadata.subtreeSummary.latestActivityLabel) || "-"} @ ${hierarchyMetadata.subtreeSummary.latestActivitySessionId || "-"}`);
      }
      if (options.verbose) {
        const tail = readLogTail(job.logFile, STATUS_LOG_TAIL_LINES);
        if (tail.length > 0) {
          lines.push("  Log tail:");
          for (const line of tail) {
            lines.push(`    ${line}`);
          }
        }
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSingleJobView(job, sessionHierarchyContext = null, recentTraceEntries = []) {
  const enriched = {
    ...job,
    elapsed:
      job.status === "running" || job.status === "queued"
        ? formatDuration(job.startedAt)
        : formatDuration(job.startedAt, job.completedAt)
  };
  const sections = ["# OpenCode Job Status", "", renderJobDetails(enriched, sessionHierarchyContext).trimEnd()];
  const hierarchySection = renderJobHierarchySection(enriched, sessionHierarchyContext).trimEnd();
  if (hierarchySection) {
    sections.push(hierarchySection);
  }
  const traceSection = renderExecutionTraceSection(recentTraceEntries, sessionHierarchyContext, {
    primarySessionId: job.sessionId ?? null,
    childSessionLimit: 12
  }).trimEnd();
  if (traceSection) {
    sections.push(traceSection);
  }
  return `${sections.filter(Boolean).join("\n\n").trimEnd()}\n`;
}

function collectActiveToolHints(recentTraceEntries = []) {
  return normalizeRecentTraceEntriesInput(recentTraceEntries)
    .filter((entry) => entry?.type === "tool")
    .map((entry) => String(entry.label ?? "").trim())
    .filter(Boolean)
    .slice(-3);
}

function buildJobLivenessEvent(job, hierarchyContext = null, recentTraceEntries = []) {
  const hierarchyMetadata = buildJobHierarchyMetadata(job, hierarchyContext);
  const activeDescendantSessionIds = hierarchyMetadata
    ? hierarchyMetadata.subtreeSummary.pendingSessionIds?.filter((id) => id && id !== job.sessionId) ?? []
    : [];
  const toolHints = collectActiveToolHints(recentTraceEntries);
  const latestActivityAt = hierarchyMetadata?.subtreeSummary.latestActivityLabel ?? job.updatedAt ?? job.startedAt ?? nowIso();
  const latestActivitySessionId = hierarchyMetadata?.subtreeSummary.latestActivitySessionId ?? job.sessionId ?? null;
  const latestActivityKind = toolHints[0]
    ? `tool:${toolHints[0]}`
    : activeDescendantSessionIds.length > 0
      ? "descendant_activity"
      : job.status === "completed" || job.status === "delegated"
        ? "job_completed"
        : job.status === "failed"
          ? "job_failed"
          : "job_status";
  const hints = {
    stale: false,
    blocked: job.status === "failed",
    interventionNeeded: job.status === "failed" || job.status === "cancelled",
    reason: job.error ?? null
  };

  return {
    at: latestActivityAt,
    type: "job.activity",
    status: job.status,
    sessionId: latestActivitySessionId,
    summary: toolHints[0] ?? job.promptSummary ?? job.error ?? job.status,
    activityKind: latestActivityKind,
    active: {
      descendantSessionIds: activeDescendantSessionIds,
      toolHints
    },
    hints,
    hierarchy: hierarchyMetadata
      ? {
          rootSessionId: hierarchyMetadata.rootSessionId,
          verdict: hierarchyMetadata.hierarchyVerdict,
          sessionCount: hierarchyMetadata.subtreeSummary.sessionCount,
          descendantCount: hierarchyMetadata.subtreeSummary.descendantCount,
          statusCounts: hierarchyMetadata.subtreeSummary.statusCounts,
          latestActivityAt: hierarchyMetadata.subtreeSummary.latestActivityLabel,
          latestActivitySessionId: hierarchyMetadata.subtreeSummary.latestActivitySessionId
        }
      : null,
    traceEntry: normalizeRecentTraceEntriesInput(recentTraceEntries).at(-1) ?? null
  };
}

function buildQuietJobResult(job, snapshot) {
  if (snapshot?.final?.combinedText) {
    return `${snapshot.final.combinedText.trimEnd()}\n`;
  }
  if (job.status === "delegated") {
    return renderJobSnapshotMarkdown(snapshot ?? readJobSnapshot(job.directory, job.id, { artifactRoot: job.artifactRoot ?? null }));
  }
  if (job.status === "failed" && (snapshot?.final?.error || job.error)) {
    return `Error: ${snapshot?.final?.error ?? job.error}\n`;
  }
  return renderJobSnapshotMarkdown(snapshot ?? readJobSnapshot(job.directory, job.id, { artifactRoot: job.artifactRoot ?? null }));
}

function buildDefaultJobStatusView(job, snapshot) {
  return renderJobSnapshotMarkdown(snapshot ?? readJobSnapshot(job.directory, job.id, { artifactRoot: job.artifactRoot ?? null }));
}

function buildVerboseJobStatusView(job, snapshot, hierarchyContext = null, recentTraceEntries = []) {
  const resolvedSnapshot = snapshot ?? readJobSnapshot(job.directory, job.id, { artifactRoot: job.artifactRoot ?? null });
  const summaryMarkdown = renderJobSnapshotMarkdown(resolvedSnapshot).trimEnd();
  const verboseSnapshotMarkdown = renderJobSnapshotMarkdown(resolvedSnapshot, { verbose: true }).trimEnd();
  const sections = [summaryMarkdown];
  const hierarchySection = renderJobHierarchySection(job, hierarchyContext).trimEnd();
  if (hierarchySection) {
    sections.push(hierarchySection);
  }
  const traceSection = renderExecutionTraceSection(
    recentTraceEntries.length > 0 ? recentTraceEntries : (resolvedSnapshot?.recentTrace ?? []),
    hierarchyContext,
    {
      primarySessionId: job.sessionId ?? null,
      childSessionLimit: 12
    }
  ).trimEnd();
  if (traceSection) {
    sections.push(traceSection);
  }
  if (!hierarchySection && !traceSection) {
    return `${verboseSnapshotMarkdown}\n`;
  }
  return `${sections.filter(Boolean).join("\n\n")}\n`;
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

const TEXT_CANDIDATE_KEYS = new Set(["text", "delta", "content", "value", "message", "markdown", "body", "reasoning", "analysis", "summary"]);
const TEXT_CANDIDATE_EXCLUDED_KEYS = new Set(["id", "type", "status", "state", "phase", "name", "tool", "toolname", "tool_name", "sessionid", "parentid", "slug"]);
const MAX_RENDERED_TRACE_ENTRIES = 12;
const DEFAULT_CHILD_TRACE_ENTRY_LIMIT = 5;
const MAX_RENDERED_TRACE_TEXT_CHARS = 1200;
const MAX_RENDERED_TRACE_DETAIL_CHARS = 600;

function normalizeMultilineText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .trim();
}

function collectKeyedText(value, allowedKeys, parts = [], seen = new Set(), hintKey = "", active = false) {
  if (typeof value === "string") {
    if (!active) {
      return parts;
    }
    const normalized = normalizeMultilineText(value);
    if (normalized && !seen.has(normalized)) {
      parts.push(normalized);
      seen.add(normalized);
    }
    return parts;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeyedText(entry, allowedKeys, parts, seen, hintKey, active);
    }
    return parts;
  }

  if (!value || typeof value !== "object") {
    return parts;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    if (TEXT_CANDIDATE_EXCLUDED_KEYS.has(normalizedKey)) {
      continue;
    }
    collectKeyedText(entry, allowedKeys, parts, seen, normalizedKey, active || allowedKeys.has(normalizedKey));
  }
  return parts;
}

function collectTextParts(value, parts = [], seen = new Set(), hintKey = "", parentType = "") {
  if (typeof value === "string") {
    const trimmed = normalizeMultilineText(value);
    if (!trimmed) {
      return parts;
    }
    const normalizedKey = hintKey.toLowerCase();
    const normalizedType = parentType.toLowerCase();
    const shouldInclude =
      TEXT_CANDIDATE_KEYS.has(normalizedKey) ||
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
  if (nextType === "step-start" || nextType === "step-finish") {
    return parts;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (TEXT_CANDIDATE_EXCLUDED_KEYS.has(String(key).toLowerCase())) {
      continue;
    }
    collectTextParts(entry, parts, seen, key, nextType);
  }
  return parts;
}

function extractTextCandidates(value) {
  return collectTextParts(value, [], new Set());
}

function extractReadablePartText(part, allowedKeys = TEXT_CANDIDATE_KEYS) {
  return collectKeyedText(part, allowedKeys, [], new Set()).join("\n\n").trim();
}

function normalizeTraceTextForRender(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function truncateTraceText(text, maxChars = MAX_RENDERED_TRACE_TEXT_CHARS) {
  const normalized = normalizeTraceTextForRender(text);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function truncateTraceHead(text, maxChars = MAX_RENDERED_TRACE_TEXT_CHARS) {
  const normalized = normalizeTraceTextForRender(text);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars)).trimEnd()}\n[truncated, showing first ${maxChars} chars of ${normalized.length}]`;
}

function truncateTraceTail(text, maxChars = MAX_RENDERED_TRACE_DETAIL_CHARS) {
  const normalized = normalizeTraceTextForRender(text);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  const rawTail = normalized.slice(-maxChars);
  const alignedTail = rawTail.includes("\n")
    ? rawTail.slice(rawTail.indexOf("\n") + 1).trimStart()
    : rawTail.trimStart();
  return `[truncated, showing last ${maxChars} chars of ${normalized.length}]\n${alignedTail}`;
}

function renderIndentedMultiline(text, indent = "  ") {
  return normalizeTraceTextForRender(text)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function summarizeScalarValue(value) {
  if (typeof value === "string") {
    return normalizeTraceTextForRender(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => summarizeScalarValue(entry))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : "";
  }
  if (value && typeof value === "object") {
    const text = extractReadablePartText(value, new Set(["text", "message", "content", "body", "output", "stdout", "stderr", "summary", "result"]));
    if (text) {
      return text;
    }
  }
  return "";
}

function extractToolCommand(part) {
  const directCandidates = [
    part?.command,
    part?.cmd,
    part?.script,
    part?.input?.command,
    part?.input?.cmd,
    part?.input?.script,
    part?.state?.command,
    part?.state?.cmd,
    part?.state?.script,
    part?.state?.input?.command,
    part?.state?.input?.cmd,
    part?.state?.input?.script,
    part?.arguments?.command,
    part?.arguments?.cmd,
    part?.arguments?.script,
    part?.state?.arguments?.command,
    part?.state?.arguments?.cmd,
    part?.state?.arguments?.script,
    part?.argv,
    part?.input?.argv,
    part?.state?.argv,
    part?.state?.input?.argv
  ];
  for (const candidate of directCandidates) {
    const summary = summarizeScalarValue(candidate);
    if (summary) {
      return summary;
    }
  }
  return "";
}

function extractToolInputSummary(part) {
  const inputCandidates = [part?.input, part?.state?.input, part?.arguments, part?.state?.arguments];
  for (const candidate of inputCandidates) {
    const summary = extractReadablePartText(
      candidate,
      new Set(["description", "prompt", "query", "command", "cmd", "script", "path", "paths", "pattern", "subagent_type", "subagent", "agent", "task_id", "taskid", "sessionid", "session_id"])
    );
    if (summary) {
      return summary;
    }
  }
  return "";
}

function extractToolDescription(part) {
  const directCandidates = [
    part?.description,
    part?.summary,
    part?.input?.description,
    part?.input?.summary,
    part?.state?.description,
    part?.state?.summary,
    part?.state?.input?.description,
    part?.state?.input?.summary,
    part?.arguments?.description,
    part?.arguments?.summary,
    part?.state?.arguments?.description,
    part?.state?.arguments?.summary
  ];
  for (const candidate of directCandidates) {
    const summary = summarizeScalarValue(candidate);
    if (summary) {
      return summary;
    }
  }
  return "";
}

function extractToolSubagent(part) {
  const directCandidates = [
    part?.subagent_type,
    part?.subagentType,
    part?.input?.subagent_type,
    part?.input?.subagentType,
    part?.state?.subagent_type,
    part?.state?.subagentType,
    part?.state?.input?.subagent_type,
    part?.state?.input?.subagentType,
    part?.arguments?.subagent_type,
    part?.arguments?.subagentType,
    part?.state?.arguments?.subagent_type,
    part?.state?.arguments?.subagentType
  ];
  for (const candidate of directCandidates) {
    const summary = summarizeScalarValue(candidate);
    if (summary) {
      return summary;
    }
  }
  return "";
}

function extractToolExitCode(part) {
  const directCandidates = [
    part?.exitCode,
    part?.exit_code,
    part?.code,
    part?.state?.exitCode,
    part?.state?.exit_code,
    part?.state?.code,
    part?.output?.exitCode,
    part?.output?.exit_code,
    part?.output?.code,
    part?.state?.output?.exitCode,
    part?.state?.output?.exit_code,
    part?.state?.output?.code,
    part?.result?.exitCode,
    part?.state?.result?.exitCode
  ];
  for (const candidate of directCandidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    return String(candidate).trim();
  }
  return "";
}

function describeToolSessionIds(part, hierarchyContext = null) {
  const sessionIds = extractSessionIdsFromTaskToolPart(part);
  if (sessionIds.length === 0) {
    return "";
  }
  return sessionIds
    .map((sessionId) => {
      const summary = hierarchyContext?.summariesById?.get?.(sessionId) ?? null;
      if (!summary) {
        return sessionId;
      }
      const summaryText = summary.summary ? ` — ${summary.summary}` : "";
      return `${sessionId} (${summary.status})${summaryText}`;
    })
    .join(", ");
}

function buildTraceEntryKey(entry) {
  return [entry.sessionId ?? "", entry.type ?? "", entry.label ?? "", entry.text ?? "", ...(entry.detailLines ?? [])].join("::");
}

function compactSingleLineText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactTraceSummaryText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((segment) => compactSingleLineText(segment))
    .filter(Boolean)
    .join(" · ");
}

function stripSimpleMarkdown(value) {
  return String(value ?? "")
    .replace(/[`*_#~]+/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1");
}

function formatLiveReasoningText(value, maxChars = 160) {
  const compact = compactTraceSummaryText(stripSimpleMarkdown(value));
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatTraceEntryInline(entry) {
  if (!entry) {
    return "";
  }
  const detailSuffix = Array.isArray(entry.detailLines) && entry.detailLines.length > 0
    ? ` — ${entry.detailLines.join(" — ")}`
    : "";
  if (entry.type === "reasoning") {
    const text = compactTraceSummaryText(entry.text);
    return text ? `${entry.label}: ${text}${detailSuffix}` : `${entry.label}${detailSuffix}`;
  }
  if (entry.text) {
    return `${entry.label ? `${entry.label}: ` : ""}${compactTraceSummaryText(entry.text)}${detailSuffix}`.trim();
  }
  return `${entry.label ?? ""}${detailSuffix}`.trim();
}

function buildReasoningTraceEntry(part, sessionId = null) {
  const text = extractReadablePartText(part, new Set(["text", "reasoning", "analysis", "content", "delta", "message", "body", "markdown", "summary"]));
  if (!text) {
    return null;
  }
  return {
    sessionId,
    type: "reasoning",
    label: "thinking",
    text: truncateTraceHead(compactTraceSummaryText(text), MAX_RENDERED_TRACE_TEXT_CHARS)
  };
}

function buildTextTraceEntry(part, sessionId = null) {
  const text = extractReadablePartText(part, new Set(["text", "content", "delta", "message", "body", "markdown", "summary"]));
  if (!text) {
    return null;
  }
  return {
    sessionId,
    type: "text",
    label: "assistant",
    text: truncateTraceHead(text, MAX_RENDERED_TRACE_TEXT_CHARS)
  };
}

function buildToolTraceEntry(part, sessionId = null, hierarchyContext = null, options = {}) {
  const name = getToolPartName(part) || String(readObjectField(part, ["name", "toolName", "tool_name"]) ?? "tool").trim().toLowerCase() || "tool";
  const state = getToolPartState(part);
  const detailLines = [];
  const exitCode = extractToolExitCode(part);
  const command = compactSingleLineText(extractToolCommand(part));
  const description = compactSingleLineText(extractToolDescription(part));
  const subagent = compactSingleLineText(extractToolSubagent(part));
  const inputSummary = compactSingleLineText(extractToolInputSummary(part));
  const compactCommand = command ? truncateTraceHead(command, MAX_RENDERED_TRACE_DETAIL_CHARS) : "";
  const compactDescription = description ? truncateTraceHead(description, MAX_RENDERED_TRACE_DETAIL_CHARS) : "";
  const compactSubagent = subagent ? truncateTraceHead(subagent, MAX_RENDERED_TRACE_DETAIL_CHARS) : "";
  const compactInputSummary = inputSummary ? truncateTraceHead(inputSummary, MAX_RENDERED_TRACE_DETAIL_CHARS) : "";
  const primaryDetail = compactCommand
    || [compactSubagent, compactDescription && compactDescription !== compactSubagent ? compactDescription : ""].filter(Boolean).join(" — ")
    || compactDescription
    || compactInputSummary;
  if (exitCode && exitCode !== "0") {
    detailLines.push(`exit ${exitCode}`);
  }
  const sessions = describeToolSessionIds(part, hierarchyContext);
  if (sessions) {
    detailLines.push(`sessions: ${sessions}`);
  }
  return {
    sessionId,
    type: "tool",
    label: `${name}${state ? ` [${state}]` : ""}${primaryDetail ? `: ${primaryDetail}` : ""}`,
    detailLines
  };
}

function buildTraceEntriesFromPart(part, sessionId = null, options = {}) {
  if (!part || typeof part !== "object") {
    return [];
  }
  const type = String(part.type ?? "").trim().toLowerCase();
  const entries = [];
  if (type === "reasoning") {
    const entry = buildReasoningTraceEntry(part, sessionId);
    if (entry) {
      entries.push(entry);
    }
  } else if (type === "tool") {
    const entry = buildToolTraceEntry(part, sessionId, options.hierarchyContext ?? null, options);
    if (entry) {
      entries.push(entry);
    }
  } else if (type === "text" && options.includeText !== false) {
    const entry = buildTextTraceEntry(part, sessionId);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function buildTraceEntriesFromMessages(messages, options = {}) {
  const entries = [];
  const seen = new Set();
  for (const message of normalizeMessageArray(messages)) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageSessionId = String(message?.info?.sessionID || message?.info?.sessionId || options.sessionId || "").trim() || null;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      for (const entry of buildTraceEntriesFromPart(part, messageSessionId, options)) {
        const key = buildTraceEntryKey(entry);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push(entry);
      }
    }
  }
  return entries;
}

function renderTraceEntriesAsText(entries) {
  return entries
    .map((entry) => formatTraceEntryInline(entry))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeRecentTraceEntriesInput(recentTraceEntries, hierarchyContext = null) {
  if (Array.isArray(recentTraceEntries)) {
    return recentTraceEntries;
  }
  if (recentTraceEntries instanceof Map) {
    const entries = [];
    for (const [sessionId, messages] of recentTraceEntries.entries()) {
      entries.push(...buildTraceEntriesFromMessages(messages, { sessionId, includeText: false, hierarchyContext }));
    }
    return entries;
  }
  return [];
}

function renderExecutionTraceSection(entries, hierarchyContext = null, options = {}) {
  const normalizedEntries = normalizeRecentTraceEntriesInput(entries, hierarchyContext);
  if (!Array.isArray(normalizedEntries) || normalizedEntries.length === 0) {
    return "";
  }
  const primarySessionId = options.primarySessionId ? String(options.primarySessionId).trim() : null;
  const childSessionLimit = Number.isInteger(options.childSessionLimit) && options.childSessionLimit > 0
    ? options.childSessionLimit
    : null;
  const skippedEntryCount = !primarySessionId && !childSessionLimit
    ? Math.max(0, normalizedEntries.length - MAX_RENDERED_TRACE_ENTRIES)
    : 0;
  const boundedEntries = skippedEntryCount > 0 ? normalizedEntries.slice(-MAX_RENDERED_TRACE_ENTRIES) : normalizedEntries;

  const grouped = new Map();
  for (const entry of boundedEntries) {
    const sessionKey = entry.sessionId || "__unknown__";
    if (!grouped.has(sessionKey)) {
      grouped.set(sessionKey, []);
    }
    grouped.get(sessionKey).push(entry);
  }

  const sessionIds = [...grouped.keys()];
  const orderedSessionIds = primarySessionId && sessionIds.includes(primarySessionId)
    ? [primarySessionId, ...sessionIds.filter((sessionId) => sessionId !== primarySessionId)]
    : sessionIds;

  const lines = ["## Recent execution trace", ""];
  if (skippedEntryCount > 0) {
    lines.push(`- … ${skippedEntryCount} earlier trace entr${skippedEntryCount === 1 ? "y" : "ies"} omitted`);
  }
  const multipleSessions = grouped.size > 1;
  for (const sessionId of orderedSessionIds) {
    const sessionEntries = grouped.get(sessionId) ?? [];
    const limitedEntries = childSessionLimit != null && sessionId !== primarySessionId && sessionEntries.length > childSessionLimit
      ? sessionEntries.slice(-childSessionLimit)
      : sessionEntries;
    const omittedSessionEntries = Math.max(0, sessionEntries.length - limitedEntries.length);
    if (multipleSessions) {
      const summary = sessionId !== "__unknown__" && hierarchyContext?.summariesById?.has(sessionId)
        ? hierarchyContext.summariesById.get(sessionId)
        : null;
      const statusSuffix = summary?.status ? ` (${summary.status})` : "";
      lines.push(`### ${sessionId === "__unknown__" ? "session" : sessionId}${statusSuffix}`);
      lines.push("");
    }
    if (omittedSessionEntries > 0) {
      lines.push(`- … ${omittedSessionEntries} earlier trace entr${omittedSessionEntries === 1 ? "y" : "ies"} omitted`);
    }
    for (const entry of limitedEntries) {
      const inlineEntry = formatTraceEntryInline(entry);
      if (inlineEntry) {
        lines.push(`- ${inlineEntry}`);
      }
    }
    if (multipleSessions) {
      lines.push("");
    }
  }

  while (lines.length > 0 && !lines.at(-1)) {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
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

function inferCompletedAssistantReply(messages) {
  const assistantNode = collectAssistantNodes(messages).at(-1);
  if (!assistantNode || typeof assistantNode !== "object") {
    return null;
  }

  const info = assistantNode.info && typeof assistantNode.info === "object" ? assistantNode.info : {};
  const parts = Array.isArray(assistantNode.parts) ? assistantNode.parts : [];
  const finish = String(info.finish ?? "").trim().toLowerCase();
  const completedAt = Number.isFinite(info?.time?.completed) ? info.time.completed : null;
  const textParts = parts
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);
  const hasStepFinish = parts.some((part) => String(part?.type ?? "").trim().toLowerCase() === "step-finish");
  const hasTerminalFinish = new Set(["stop", "length", "content_filter", "max_tokens"]).has(finish);

  if (!textParts.length) {
    return null;
  }

  if ((completedAt || hasStepFinish) && (hasTerminalFinish || hasStepFinish)) {
    return {
      completedAt,
      finish: finish || null,
      hasStepFinish,
      text: textParts.join("\n\n")
    };
  }

  return null;
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
  rawSessionStatus = status,
  hierarchyVerdict = null,
  recommendedAction = null,
  sessionSummary = null
}) {
  const assistantNodes = collectAssistantNodes(messages);
  const preferredNode = assistantNodes.at(-1) ?? normalizeMessageArray(messages).at(-1) ?? messages;
  const traceEntries = buildTraceEntriesFromMessages([preferredNode], { sessionId, includeText: true });
  const finalText = (Array.isArray(preferredNode?.parts) ? preferredNode.parts : [])
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const fallbackText = extractTextCandidates(preferredNode).join("\n\n").trim();
  const textParts = traceEntries
    .flatMap((entry) => [entry.text, ...(entry.detailLines ?? [])])
    .filter(Boolean);
  const combinedText = renderTraceEntriesAsText(traceEntries) || fallbackText || String(streamedText ?? "").trim();
  const fileChanges = extractFileChanges(messages);

  return {
    session_id: String(sessionId),
    directory,
    status,
    completion_mode: completionMode,
    raw_session_status: normalizeSessionStatus(rawSessionStatus),
    hierarchy_verdict: hierarchyVerdict,
    recommended_action: recommendedAction,
    main_session_last_usage: sessionSummary?.lastUsage ?? null,
    main_session_total_usage: sessionSummary?.totalUsage ?? null,
    main_session_context: sessionSummary?.contextSummary ?? null,
    text_parts: textParts,
    combined_text: combinedText,
    final_text: finalText || fallbackText || String(streamedText ?? "").trim(),
    file_changes: fileChanges,
    message_count: normalizeMessageArray(messages).length,
    messages: normalizeMessageArray(messages)
  };
}

function renderTaskSummary(result) {
  const lines = [
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
  if (result.hierarchy_verdict) {
    lines.push(`Hierarchy verdict: ${result.hierarchy_verdict}`);
  }
  if (result.recommended_action) {
    lines.push(`Recommended action: ${result.recommended_action}`);
  }
  const lastUsage = formatUsageSummary(result.main_session_last_usage);
  if (lastUsage !== "-") {
    lines.push(`Main session last usage: ${lastUsage}`);
  }
  const totalUsage = formatUsageSummary(result.main_session_total_usage);
  if (totalUsage !== "-") {
    lines.push(`Main session total usage: ${totalUsage}`);
  }
  const contextSummary = formatContextSummary(result.main_session_context);
  if (contextSummary !== "-") {
    lines.push(`Main session context: ${contextSummary}`);
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

function padTimestampPart(value) {
  return String(value).padStart(2, "0");
}

function formatReadableTimestamp(value) {
  if (value == null) {
    return "";
  }
  const parsed = parseSessionTimestamp(value);
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

function readUsageField(record, keys) {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function parseUsageNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUsageCost(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUsageSummary(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { raw: trimmed } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const inputTokens = parseUsageNumber(readUsageField(value, ["inputTokens", "input_tokens", "InputTokens", "input", "Input"]));
  const outputTokens = parseUsageNumber(readUsageField(value, ["outputTokens", "output_tokens", "OutputTokens", "output", "Output"]));
  const cachedTokens = parseUsageNumber(readUsageField(value, ["cachedTokens", "cached_tokens", "CachedTokens", "cached", "Cached"]));
  const explicitTotalTokens = parseUsageNumber(
    readUsageField(value, ["totalTokens", "total_tokens", "TotalTokens", "tokenCount", "token_count", "TokenCount", "tokens", "Tokens"])
  );
  const costUsd = parseUsageCost(readUsageField(value, ["costUsd", "cost_usd", "CostUsd", "cost", "Cost"]));

  const hasTokenBreakdown = [inputTokens, outputTokens, cachedTokens].some((entry) => entry != null);
  const totalTokens = explicitTotalTokens ?? (hasTokenBreakdown ? (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedTokens ?? 0) : null);

  if ([inputTokens, outputTokens, cachedTokens, totalTokens, costUsd].every((entry) => entry == null)) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    costUsd
  };
}

function firstUsageSummary(candidates) {
  for (const candidate of candidates) {
    const summary = normalizeUsageSummary(candidate);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function normalizeContextSummary(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { raw: trimmed } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const usedTokens = parseUsageNumber(readUsageField(value, [
    "usedTokens",
    "used_tokens",
    "UsedTokens",
    "currentTokens",
    "current_tokens",
    "CurrentTokens",
    "contextTokens",
    "context_tokens",
    "ContextTokens",
    "tokens",
    "Tokens",
    "tokenCount",
    "token_count",
    "TokenCount"
  ]));
  const limitTokens = parseUsageNumber(readUsageField(value, [
    "limitTokens",
    "limit_tokens",
    "LimitTokens",
    "maxTokens",
    "max_tokens",
    "MaxTokens",
    "contextLimit",
    "context_limit",
    "ContextLimit",
    "contextWindow",
    "context_window",
    "ContextWindow",
    "windowTokens",
    "window_tokens",
    "WindowTokens"
  ]));
  const remainingTokens = parseUsageNumber(readUsageField(value, [
    "remainingTokens",
    "remaining_tokens",
    "RemainingTokens",
    "availableTokens",
    "available_tokens",
    "AvailableTokens"
  ]));

  if ([usedTokens, limitTokens, remainingTokens].every((entry) => entry == null)) {
    return null;
  }

  return { usedTokens, limitTokens, remainingTokens };
}

function firstContextSummary(candidates) {
  for (const candidate of candidates) {
    const summary = normalizeContextSummary(candidate);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function summarizeSessionUsage(session) {
  const usage = session?.usage ?? null;
  const lastUsage = firstUsageSummary([
    session?.lastUsage,
    session?.last_usage,
    session?.LastUsage,
    usage?.lastUsage,
    usage?.last_usage,
    usage?.LastUsage,
    usage?.last,
    usage?.latest,
    usage?.recent
  ]);
  const totalUsage = firstUsageSummary([
    session?.totalUsage,
    session?.total_usage,
    session?.TotalUsage,
    usage?.totalUsage,
    usage?.total_usage,
    usage?.TotalUsage,
    usage?.total,
    usage?.aggregate,
    usage?.lifetime,
    usage?.overall,
    usage
  ]);

  return { lastUsage, totalUsage };
}

function summarizeSessionContext(session) {
  const usage = session?.usage ?? null;
  const context = session?.context ?? null;
  return firstContextSummary([
    session?.contextUsage,
    session?.context_usage,
    session?.ContextUsage,
    session?.contextWindowUsage,
    session?.context_window_usage,
    session?.ContextWindowUsage,
    context?.usage,
    context?.windowUsage,
    context?.window_usage,
    context,
    usage?.context,
    usage?.contextUsage,
    usage?.context_usage,
    usage?.contextWindow,
    usage?.context_window,
    {
      contextTokens: session?.contextTokens ?? session?.context_tokens ?? session?.contextLength ?? session?.context_length,
      contextLimit: session?.contextLimit ?? session?.context_limit ?? session?.contextWindow ?? session?.context_window,
      remainingTokens: session?.remainingContextTokens ?? session?.remaining_context_tokens
    }
  ]);
}

const usageNumberFormatter = new Intl.NumberFormat("en-US");

function formatUsageCost(costUsd) {
  if (costUsd == null || !Number.isFinite(costUsd)) {
    return null;
  }
  const fractionDigits = costUsd !== 0 && Math.abs(costUsd) < 0.01 ? 4 : 2;
  return `$${costUsd.toFixed(fractionDigits)}`;
}

function formatUsageSummary(usage) {
  if (!usage) {
    return "-";
  }
  if (usage.raw) {
    return usage.raw;
  }

  const parts = [];
  if (usage.totalTokens != null) {
    parts.push(`${usageNumberFormatter.format(usage.totalTokens)} total`);
  }
  if (usage.inputTokens != null) {
    parts.push(`in ${usageNumberFormatter.format(usage.inputTokens)}`);
  }
  if (usage.outputTokens != null) {
    parts.push(`out ${usageNumberFormatter.format(usage.outputTokens)}`);
  }
  if (usage.cachedTokens != null) {
    parts.push(`cached ${usageNumberFormatter.format(usage.cachedTokens)}`);
  }
  const formattedCost = formatUsageCost(usage.costUsd);
  if (formattedCost) {
    parts.push(formattedCost);
  }
  return parts.join(", ") || "-";
}

function formatContextSummary(context) {
  if (!context) {
    return "-";
  }
  if (context.raw) {
    return context.raw;
  }
  const parts = [];
  if (context.usedTokens != null && context.limitTokens != null) {
    const percentage = context.limitTokens > 0 ? ` (${((context.usedTokens / context.limitTokens) * 100).toFixed(1)}%)` : "";
    parts.push(`${usageNumberFormatter.format(context.usedTokens)} / ${usageNumberFormatter.format(context.limitTokens)}${percentage}`);
  } else if (context.usedTokens != null) {
    parts.push(`${usageNumberFormatter.format(context.usedTokens)} used`);
  } else if (context.limitTokens != null) {
    parts.push(`${usageNumberFormatter.format(context.limitTokens)} limit`);
  }
  if (context.remainingTokens != null) {
    parts.push(`${usageNumberFormatter.format(context.remainingTokens)} remaining`);
  }
  return parts.join(", ") || "-";
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
  const { lastUsage, totalUsage } = summarizeSessionUsage(session);
  const contextSummary = summarizeSessionContext(session);

  return {
    id: session.id || session.sessionID || session.sessionId || "unknown",
    parentId: String(parentId || ""),
    status: String(status),
    createdAt: String(createdAt || ""),
    createdAtMs: parseSessionTimestamp(createdAt),
    updatedAt: String(updatedAt || ""),
    updatedAtMs: parseSessionTimestamp(updatedAt),
    lastUsage,
    totalUsage,
    contextSummary,
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
    `| started at | ${escapeMarkdownCell(state?.startedAt ? formatReadableTimestamp(state.startedAt) : "none")} |`,
    `| health | ${escapeMarkdownCell(healthy ? "healthy" : "not reachable")} |`
  ];

  lines.push(
    "",
    "Recent sessions",
    "",
    "| id | status | created | updated | last usage | total usage | summary |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );

  if (sessionError) {
    lines.push(`| unavailable | error |  |  | - | - | ${escapeMarkdownCell(sessionError)} |`);
  } else if (!sessions || sessions.length === 0) {
    lines.push("| none | - | - | - | - | - | No sessions reported by the server. |");
  } else {
    for (const session of sessions.slice(0, STATUS_SESSION_LIMIT).map(summarizeSession)) {
      lines.push(
        `| ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(formatReadableTimestamp(session.createdAt))} | ${escapeMarkdownCell(formatReadableTimestamp(session.updatedAt))} | ${escapeMarkdownCell(formatUsageSummary(session.lastUsage))} | ${escapeMarkdownCell(formatUsageSummary(session.totalUsage))} | ${escapeMarkdownCell(session.summary)} |`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderSessionTable(sessions) {
  const hierarchyContext = buildSessionHierarchyContext(sessions);
  const lines = [
    "| tree | id | parent | raw | observed | created | updated | last usage | total usage | summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  if (!sessions || sessions.length === 0) {
    lines.push("| none | - | - | - | - | - | - | - | - | No sessions reported by the server. |");
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
      `| ${escapeMarkdownCell(treeLabel)} | ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.parentId || "-")} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(observedStatus)} | ${escapeMarkdownCell(formatReadableTimestamp(session.createdAt))} | ${escapeMarkdownCell(formatReadableTimestamp(session.updatedAt))} | ${escapeMarkdownCell(formatUsageSummary(session.lastUsage))} | ${escapeMarkdownCell(formatUsageSummary(session.totalUsage))} | ${escapeMarkdownCell(session.summary)} |`
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

function renderSessionDetails(session, directory, hierarchyContext = null, recentTraceEntries = []) {
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
  const nextAction = recommendHierarchyAction(hierarchyVerdict, details.id, details, subtreeSummary, recentTraceEntries);
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
    `| created | ${escapeMarkdownCell(formatReadableTimestamp(details.createdAt))} |`,
    `| updated | ${escapeMarkdownCell(formatReadableTimestamp(details.updatedAt))} |`,
    `| last usage | ${escapeMarkdownCell(formatUsageSummary(details.lastUsage))} |`,
    `| total usage | ${escapeMarkdownCell(formatUsageSummary(details.totalUsage))} |`,
    `| context | ${escapeMarkdownCell(formatContextSummary(details.contextSummary))} |`,
    `| hierarchy size | ${escapeMarkdownCell(subtreeSummary.sessionCount)} |`,
    `| hierarchy statuses | ${escapeMarkdownCell(formatHierarchyStatusCounts(subtreeSummary.statusCounts))} |`,
    `| hierarchy latest activity | ${escapeMarkdownCell(formatReadableTimestamp(subtreeSummary.latestActivityLabel) || "-")} |`,
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

function buildSingleSessionView(directory, session, hierarchyContext = null, recentTraceEntries = []) {
  const effectiveHierarchyContext = hierarchyContext ?? buildSessionHierarchyContext([session]);
  const details = summarizeSession(session);
  const rootSessionId = findSessionRootId(details.id, effectiveHierarchyContext);
  const sections = [
    "# OpenCode Session Status",
    "",
    renderSessionDetails(session, directory, effectiveHierarchyContext, recentTraceEntries).trimEnd(),
    "",
    "## Session Hierarchy",
    "",
    renderSessionHierarchyTable(effectiveHierarchyContext, rootSessionId).trimEnd()
  ];
  const traceSection = renderExecutionTraceSection(recentTraceEntries, effectiveHierarchyContext, {
    primarySessionId: details.id,
    childSessionLimit: DEFAULT_CHILD_TRACE_ENTRY_LIMIT
  }).trimEnd();
  if (traceSection) {
    sections.push("", traceSection);
  }
  return sections.join("\n") + "\n";
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
    return `read final result or inspect artifacts; session continue ${sessionId} only if reuse still makes sense`;
  }
  if (verdict === "failed") {
    return `inspect artifacts, then consider session new if reuse is no longer useful`;
  }
  return `session attach ${sessionId} to determine whether reuse is still viable`;
}

function looksRecentlyFinishedSession(details, subtreeSummary) {
  if (!isSuccessfulTerminalSessionStatus(details?.status)) {
    return false;
  }
  const statusCounts = subtreeSummary?.statusCounts;
  if (!statusCounts || typeof statusCounts !== "object") {
    return false;
  }
  const busyCount = countStatuses(statusCounts, ["busy", "active", "running", "working"]);
  const failedCount = countStatuses(statusCounts, ["aborted", "cancelled", "canceled", "failed", "error"]);
  return busyCount === 0 && failedCount === 0;
}

function isCompletedToolTraceEntry(entry) {
  if (!entry || entry.type !== "tool") {
    return false;
  }
  return /\[(completed|complete|done|success)\](?::|$)/i.test(String(entry.label ?? "").trim());
}

function looksTraceCompleteRecentlyFinishedSession(details, subtreeSummary, recentTraceEntries = []) {
  const normalizedStatus = normalizeSessionStatus(details?.status || "unknown");
  if (isBusySessionStatus(normalizedStatus) || isFailedTerminalSessionStatus(normalizedStatus)) {
    return false;
  }
  if ((subtreeSummary?.descendantCount ?? 0) !== 0) {
    return false;
  }
  const recency = deriveActivityRecency(subtreeSummary?.latestActivityMs ?? latestKnownSessionActivityAt(details, null));
  if (!new Set(["active_recent", "recently_active"]).has(recency)) {
    return false;
  }
  const primaryEntries = normalizeRecentTraceEntriesInput(recentTraceEntries).filter((entry) => entry?.sessionId === details?.id);
  return isCompletedToolTraceEntry(primaryEntries.at(-1));
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
  return new Set(["aborted", "cancelled", "canceled", "failed", "error", "question_needed", "permission_needed"]).has(normalizeSessionStatus(status));
}

function deriveResultStatus({ terminalStatus, abortedBySignal, completionMode }) {
  if (abortedBySignal) {
    return "aborted";
  }
  if (completionMode === "question_needed") {
    return "question_needed";
  }
  if (completionMode === "permission_needed") {
    return "permission_needed";
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

function deriveTaskHierarchyVerdict({
  terminalStatus,
  completionMode,
  hierarchyVerdict = null,
  sawDelegatedHierarchy = false,
  hasPendingDescendants = false,
  hasFailedDescendants = false,
  pendingToolSessionIds = []
}) {
  if (hierarchyVerdict) {
    return hierarchyVerdict;
  }
  if (completionMode === "descendant_failed" || hasFailedDescendants) {
    return "descendant_failed";
  }
  if (completionMode === "question_needed" || completionMode === "permission_needed") {
    return completionMode;
  }
  if (pendingToolSessionIds.length > 0 || hasPendingDescendants) {
    return sawDelegatedHierarchy ? "active_descendants" : "active";
  }
  if (completionMode === "delegated_settled") {
    return "quiet_delegated";
  }
  if (completionMode === "quiescence") {
    return "quiet_root";
  }
  if (isSuccessfulTerminalSessionStatus(terminalStatus)) {
    return "completed_tree";
  }
  if (isFailedTerminalSessionStatus(terminalStatus)) {
    return sawDelegatedHierarchy ? "descendant_failed" : "failed_root";
  }
  if (sawDelegatedHierarchy) {
    return "quiet_delegated";
  }
  if (isBusySessionStatus(terminalStatus)) {
    return "quiet_root";
  }
  return "unknown";
}

function deriveRecommendedTaskAction({ status, completionMode, hierarchyVerdict }) {
  if (status === "question_needed" || completionMode === "question_needed") {
    return "answer_question";
  }
  if (status === "permission_needed" || completionMode === "permission_needed") {
    return "approve_or_deny_permission";
  }
  if (status === "delegated") {
    return "session_status_or_attach";
  }
  if (status === "failed") {
    return "inspect_artifacts";
  }
  if (status === "aborted") {
    return "session_status";
  }
  if (completionMode === "quiescence" || hierarchyVerdict === "quiet_root") {
    return "inspect_artifacts_or_session_status";
  }
  if (status === "completed") {
    return "inspect_artifacts";
  }
  return "session_attach";
}

function classifySessionOutcome({
  sessionId,
  terminalStatus,
  rawSessionStatus = terminalStatus,
  abortedBySignal,
  completionMode,
  hierarchyVerdict = null,
  sawDelegatedHierarchy = false,
  hasPendingDescendants = false,
  hasFailedDescendants = false,
  pendingToolSessionIds = []
}) {
  const status = deriveResultStatus({ terminalStatus, abortedBySignal, completionMode });
  const resolvedHierarchyVerdict = deriveTaskHierarchyVerdict({
    terminalStatus,
    completionMode,
    hierarchyVerdict,
    sawDelegatedHierarchy,
    hasPendingDescendants,
    hasFailedDescendants,
    pendingToolSessionIds
  });

  return {
    status,
    completionMode: completionMode ?? "terminal",
    rawSessionStatus: normalizeSessionStatus(rawSessionStatus ?? terminalStatus),
    hierarchyVerdict: resolvedHierarchyVerdict,
    recommendedAction: deriveRecommendedTaskAction({
      sessionId,
      status,
      completionMode: completionMode ?? "terminal",
      hierarchyVerdict: resolvedHierarchyVerdict
    })
  };
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

function recommendHierarchyAction(verdict, sessionId, details = null, subtreeSummary = null, recentTraceEntries = []) {
  if (
    looksRecentlyFinishedSession(details, subtreeSummary)
    || looksTraceCompleteRecentlyFinishedSession(details, subtreeSummary, recentTraceEntries)
  ) {
    return `read final result or inspect artifacts; session continue ${sessionId} only if reuse still makes sense`;
  }
  if (["active", "active_descendants", "recently_active", "settling_descendants", "failed_with_recent_activity"].includes(verdict)) {
    return `wait or session attach ${sessionId}`;
  }
  if (["completed", "completed_tree"].includes(verdict)) {
    return `read final result or inspect artifacts; session continue ${sessionId} only if reuse still makes sense`;
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
  const pendingSessionIds = [];
  const statusCounts = {};
  let latestActivityMs = null;
  let latestActivityLabel = "";
  let latestActivitySessionId = null;
  const pendingGraceMs = readHierarchyPendingGraceMs();

  for (const sessionId of subtreeSessionIds) {
    const session = hierarchyContext.summariesById.get(sessionId);
    const normalizedStatus = normalizeSessionStatus(session?.status || "unknown");
    statusCounts[normalizedStatus] = (statusCounts[normalizedStatus] ?? 0) + 1;
    const activityMs = latestKnownSessionActivityAt(session, null);
    const isTerminal = isSuccessfulTerminalSessionStatus(normalizedStatus) || isFailedTerminalSessionStatus(normalizedStatus);
    const isPendingForStatus = isBusySessionStatus(normalizedStatus)
      || (!isTerminal && (!Number.isFinite(activityMs) || Date.now() - activityMs < pendingGraceMs));
    if (isPendingForStatus) {
      pendingSessionIds.push(sessionId);
    }
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
    pendingSessionIds,
    statusCounts,
    latestActivityMs,
    latestActivityLabel,
    latestActivitySessionId
  };
}

function renderSessionHierarchyTable(hierarchyContext, rootSessionId) {
  const lines = [
    "| tree | id | parent | raw | observed | updated |",
    "| --- | --- | --- | --- | --- | --- |"
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
      `| ${escapeMarkdownCell(treeLabel)} | ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.parentId || "-")} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(observedStatus)} | ${escapeMarkdownCell(formatReadableTimestamp(session.updatedAt || session.createdAt || ""))} |`
    );
    for (const childId of hierarchyContext.childrenByParent.get(sessionId) ?? []) {
      appendRows(childId, depth + 1);
    }
  };

  appendRows(rootSessionId, 0);
  return `${lines.join("\n")}\n`;
}

async function tryGetHealthyBaseUrl(serverDirectory) {
  const managedState = normalizeState(readState(serverDirectory));
  if (!managedState || !isPidRunning(managedState.pid)) {
    return null;
  }
  const baseUrl = buildBaseUrl(managedState.port);
  if (!(await checkHealth(baseUrl))) {
    return null;
  }
  return baseUrl;
}

async function tryGetLiveSessionHierarchyContext(serverDirectory, directory) {
  const baseUrl = await tryGetHealthyBaseUrl(serverDirectory);
  if (!baseUrl) {
    return null;
  }
  try {
    const sessions = await listSessions(baseUrl, directory);
    return buildSessionHierarchyContext(sessions);
  } catch {
    return null;
  }
}

async function listHierarchyTraceEntries(baseUrl, directory, rootSessionId, hierarchyContext) {
  const sessionIds = [...new Set([rootSessionId, ...collectDescendantIds(rootSessionId, hierarchyContext)].filter(Boolean))];
  const traceEntries = [];
  await Promise.all(
    sessionIds.map(async (currentSessionId) => {
      try {
        const messages = await listSessionMessages(baseUrl, directory, currentSessionId);
        traceEntries.push(...buildTraceEntriesFromMessages(messages, {
          sessionId: currentSessionId,
          includeText: false,
          hierarchyContext
        }));
      } catch {
        // Best-effort only.
      }
    })
  );
  return traceEntries;
}

async function tryCollectLiveSessionTraceEntries(serverDirectory, directory, sessionId, hierarchyContext = null) {
  const baseUrl = await tryGetHealthyBaseUrl(serverDirectory);
  if (!baseUrl) {
    return [];
  }

  let effectiveHierarchyContext = hierarchyContext;
  if (!effectiveHierarchyContext) {
    try {
      const sessions = await listSessions(baseUrl, directory);
      effectiveHierarchyContext = buildSessionHierarchyContext(sessions);
    } catch {
      return [];
    }
  }

  const rootSessionId = findSessionRootId(sessionId, effectiveHierarchyContext);
  try {
    return await listHierarchyTraceEntries(baseUrl, directory, rootSessionId, effectiveHierarchyContext);
  } catch {
    return [];
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

function createTextStreamPrinter(options = {}) {
  const emitLive = options.emitLive !== false;
  let output = "";
  let emittedOutput = "";
  let lastBlockType = null;
  const seenReasoningParts = new Set();
  const reasoningBuffers = new Map();
  const reasoningPrinted = new Map();
  let hasTraceOutput = false;

  function printDelta(snippet) {
    const normalized = String(snippet ?? "").replace(/\r/g, "");
    if (normalized.length === 0) {
      return;
    }

    if (emitLive) {
      process.stdout.write(normalized);
      emittedOutput += normalized;
    }
    output += normalized;
  }

  function ensureLineBreak() {
    if (output && !output.endsWith("\n")) {
      printDelta("\n");
    }
  }

  return {
    handleTextDelta(delta) {
      if (lastBlockType && lastBlockType !== "text") {
        ensureLineBreak();
      }
      lastBlockType = "text";
      printDelta(delta);
    },
    handleReasoningDelta(partId, delta) {
      const normalized = String(delta ?? "").replace(/\r/g, "");
      if (!normalized) {
        return;
      }
      const nextBuffer = `${reasoningBuffers.get(partId) ?? ""}${normalized}`;
      reasoningBuffers.set(partId, nextBuffer);
      const compactText = formatLiveReasoningText(nextBuffer);
      if (!compactText) {
        return;
      }
      if (!seenReasoningParts.has(partId)) {
        ensureLineBreak();
        printDelta("thinking: ");
        seenReasoningParts.add(partId);
      }
      const previousPrinted = reasoningPrinted.get(partId) ?? "";
      if (compactText.startsWith(previousPrinted)) {
        const suffix = compactText.slice(previousPrinted.length);
        if (suffix) {
          printDelta(suffix);
        }
      }
      reasoningPrinted.set(partId, compactText);
      hasTraceOutput = true;
      lastBlockType = "reasoning";
    },
    handleToolEvent(entry) {
      if (!entry) {
        return;
      }
      const inlineEntry = formatTraceEntryInline(entry);
      if (!inlineEntry) {
        return;
      }
      ensureLineBreak();
      printDelta(`${inlineEntry}\n`);
      hasTraceOutput = true;
      lastBlockType = "tool";
    },
    handleDelta(delta) {
      this.handleTextDelta(delta);
    },
    getOutput() {
      return output;
    },
    getEmittedOutput() {
      return emittedOutput;
    },
    hasTraceOutput() {
      return hasTraceOutput;
    },
    isLiveEmitting() {
      return emitLive;
    },
    ensureLineBreak() {
      ensureLineBreak();
    }
  };
}

function renderQuietCompletionHint(sessionId) {
  return [
    "To inspect progress or trace details later:",
    `- session attach ${sessionId}`,
    `- session status ${sessionId}`
  ].join("\n");
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

function readObjectField(object, keys) {
  if (!object || typeof object !== "object") {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      return object[key];
    }
  }
  return undefined;
}

function getToolPartName(part) {
  const directValue = readObjectField(part, ["tool", "name", "toolName", "tool_name"]);
  if (typeof directValue === "string") {
    return directValue.trim().toLowerCase();
  }
  if (directValue && typeof directValue === "object") {
    const nestedValue = readObjectField(directValue, ["name", "toolName", "tool_name", "id"]);
    if (typeof nestedValue === "string") {
      return nestedValue.trim().toLowerCase();
    }
  }
  return "";
}

function getToolPartState(part) {
  const state = part?.state;
  if (typeof state === "string") {
    return normalizeToolState(state);
  }
  return normalizeToolState(readObjectField(state, ["status", "type", "state", "phase"]) ?? readObjectField(part, ["status"]));
}

function isTaskToolPart(part) {
  if (!part || typeof part !== "object" || part.type !== "tool") {
    return false;
  }
  return getToolPartName(part) === "task";
}

function isTerminalToolState(state) {
  return new Set(["completed", "complete", "done", "success", "failed", "error", "cancelled", "canceled", "aborted"]).has(
    normalizeToolState(state)
  );
}

function isActiveTaskToolPart(part) {
  if (!isTaskToolPart(part)) {
    return false;
  }
  const state = getToolPartState(part);
  return !state || !isTerminalToolState(state);
}

function collectStringsDeep(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStringsDeep(entry, output);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringsDeep(entry, output);
  }
  return output;
}

function extractSessionIdsFromTaskToolPart(part) {
  const ids = new Set();
  const candidates = [
    readObjectField(part, ["task_id", "taskId", "sessionID", "sessionId"]),
    readObjectField(part?.state, ["task_id", "taskId", "sessionID", "sessionId"]),
    readObjectField(part?.state?.output, ["task_id", "taskId", "sessionID", "sessionId"]),
    readObjectField(part?.state?.result, ["task_id", "taskId", "sessionID", "sessionId"]),
    readObjectField(part, ["output", "result"]),
    part?.state?.output,
    part?.state?.result
  ];
  for (const candidate of candidates) {
    for (const text of collectStringsDeep(candidate)) {
      for (const match of text.matchAll(/(?:task_id|taskId|sessionID|sessionId)\s*[:=]\s*['"]?([A-Za-z0-9_-]*ses_[A-Za-z0-9_-]+|ses_[A-Za-z0-9_-]+)/g)) {
        ids.add(match[1]);
      }
    }
  }
  return [...ids];
}

function extractBackgroundJobIdsFromText(text) {
  const ids = new Set();
  for (const match of String(text ?? "").matchAll(/OpenCode task started in background as\s+(task-[A-Za-z0-9_-]+)/gi)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function isCompanionJobActive(directory, jobId) {
  try {
    refreshStaleRunningJobs(directory);
    return isActiveJob(readJob(directory, jobId));
  } catch {
    return false;
  }
}

async function findActiveCompanionJobs(directory, jobIds) {
  return [...new Set((jobIds ?? []).filter(Boolean))].filter((id) => isCompanionJobActive(directory, id));
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

function readPrompt(positionals, options = {}) {
  const promptFile = options["prompt-file"] ? String(options["prompt-file"]) : null;
  if (promptFile) {
    if (positionals.length > 0) {
      throw new Error("Cannot combine --prompt-file with an inline prompt after `--`.");
    }
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }
    const text = fs.readFileSync(promptFile, "utf8").trim();
    // Internal background workers pass --prompt-file alongside --job-id; the
    // sidecar file is a managed temp and should be removed once consumed.
    if (options["job-id"]) {
      try { fs.unlinkSync(promptFile); } catch {}
    }
    return text;
  }
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
  const explicitChildSessionIds = new Set();
  const activeTaskToolKeys = new Set();
  const companionBackgroundJobIds = new Set();
  const pendingUnscopedInterventions = new Map();
  let pendingIntervention = null;
  let sawDelegatedHierarchy = false;
  let lastDirectoryActivityAt = Date.now();
  let lastMainSessionActivityAt = Date.now();
  let lastPrintedSessionId = null;
  const partTypes = new Map(); // partID -> part type (e.g. "text", "reasoning", "tool")
  const printedToolSignatures = new Map();
  const QUIESCENCE_TIMEOUT_MS = readEnvDurationMs("OPENCODE_QUIESCENCE_TIMEOUT_MS", 5000);
  const FORCE_QUIESCENCE_TIMEOUT_MS = readEnvDurationMs("OPENCODE_FORCE_QUIESCENCE_TIMEOUT_MS", 30000);
  // Decoupled from FORCE_QUIESCENCE_TIMEOUT_MS so subagent silence does not auto-mark a session as
  // not-pending the moment the directory-level fallback would also fire. Default 5 minutes; never
  // shorter than FORCE_QUIESCENCE_TIMEOUT_MS to keep prior intent (a busy session won't be considered
  // settled before the directory itself is).
  const HIERARCHY_PENDING_GRACE_MS = readHierarchyPendingGraceMs();
  const STATUS_POLL_INTERVAL_MS = readEnvDurationMs("OPENCODE_STATUS_POLL_INTERVAL_MS", 1500);
  // OpenCode 1.14.46 can close the SSE event stream several seconds before the
  // session reaches a terminal idle/completed state in persistence. Keep polling
  // long enough to let session/message state catch up before declaring failure.
  const STREAM_CLOSE_GRACE_MS = readEnvDurationMs("OPENCODE_STREAM_CLOSE_GRACE_MS", 10000);
  const SETTLING_CHECK_INTERVAL_MS = readEnvDurationMs("OPENCODE_SETTLING_CHECK_INTERVAL_MS", 1000);
  const timeoutMs = timeoutMins * 60 * 1000;
  const startTime = Date.now();
  let lastStatusPollAt = 0;

  function trackExplicitChildSession(childSessionId) {
    if (!childSessionId) return;
    explicitChildSessionIds.add(childSessionId);
    if (!directorySessions.has(childSessionId)) {
      directorySessions.set(childSessionId, { status: "unknown", lastActivityAt: Date.now() });
    }
  }

  function trackToolPartSnapshot(eventSessionId, part, fallbackPartId = "task") {
    if (!part || typeof part !== "object") return;
    for (const jobId of extractBackgroundJobIdsFromText(collectStringsDeep(part).join("\n"))) {
      companionBackgroundJobIds.add(jobId);
    }
    if (!isTaskToolPart(part)) return;
    const partKey = `${eventSessionId}:${part.id || fallbackPartId}`;
    for (const childSessionId of extractSessionIdsFromTaskToolPart(part)) {
      trackExplicitChildSession(childSessionId);
    }
    if (isActiveTaskToolPart(part)) {
      activeTaskToolKeys.add(partKey);
      sawDelegatedHierarchy = true;
    } else {
      activeTaskToolKeys.delete(partKey);
    }
  }

  async function reconcileMessageSnapshots(sessionIds) {
    const uniqueSessionIds = [...new Set((sessionIds ?? []).filter(Boolean))];
    const activeKeysFromSnapshots = new Set();
    await Promise.all(uniqueSessionIds.map(async (currentSessionId) => {
      let messages = [];
      try {
        messages = await listSessionMessages(baseUrl, directory, currentSessionId);
      } catch {
        return;
      }
      for (const message of normalizeMessageArray(messages)) {
        for (const jobId of extractBackgroundJobIdsFromText(collectStringsDeep(message).join("\n"))) {
          companionBackgroundJobIds.add(jobId);
        }
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          trackToolPartSnapshot(currentSessionId, part, part.id || message?.info?.id || "snapshot");
          if (isActiveTaskToolPart(part)) {
            activeKeysFromSnapshots.add(`${currentSessionId}:${part.id || message?.info?.id || "snapshot"}`);
          }
        }
      }
    }));

    for (const key of [...activeTaskToolKeys]) {
      const [keySessionId] = key.split(":");
      if (uniqueSessionIds.includes(keySessionId) && !activeKeysFromSnapshots.has(key)) {
        activeTaskToolKeys.delete(key);
      }
    }
  }

  async function getMonitorBlocker({ pendingToolSessionIds = [] } = {}) {
    if (pendingIntervention) {
      return { type: pendingIntervention.type };
    }
    if (activeTaskToolKeys.size > 0) {
      return { type: "active_task_tools", ids: [...activeTaskToolKeys] };
    }
    const activeCompanionJobIds = await findActiveCompanionJobs(directory, [...companionBackgroundJobIds]);
    if (activeCompanionJobIds.length > 0) {
      return { type: "active_companion_jobs", ids: activeCompanionJobIds };
    }
    if (pendingToolSessionIds.length > 0) {
      return { type: "pending_tool_sessions", ids: pendingToolSessionIds };
    }
    return null;
  }

  function interventionResult(type) {
    log(`OpenCode is waiting for ${type === "question_needed" ? "a question response" : "permission approval"}.`);
    process.exitCode = 1;
    return {
      done: true,
      completionMode: type,
      terminalStatus: type,
      rawSessionStatus: type,
      hierarchyVerdict: type,
      hasPendingDescendants: false,
      hasFailedDescendants: false,
      pendingToolSessionIds: []
    };
  }

  function isMonitoredEventSession(eventSessionId) {
    return Boolean(
      eventSessionId &&
      (eventSessionId === sessionId ||
        hierarchySessionIds.has(eventSessionId) ||
        explicitChildSessionIds.has(eventSessionId))
    );
  }

  function promotePendingUnscopedInterventions() {
    if (pendingIntervention) return;
    for (const [candidateSessionId, candidate] of pendingUnscopedInterventions.entries()) {
      if (!isMonitoredEventSession(candidateSessionId)) {
        continue;
      }
      pendingIntervention = candidate;
      pendingUnscopedInterventions.delete(candidateSessionId);
      return;
    }
  }

  async function refreshSessionHierarchy() {
    const sessionSummaries = (await listSessions(baseUrl, directory)).map(summarizeSession);
    sessionSummariesById = new Map(sessionSummaries.map((session) => [session.id, session]));
    hierarchySessionIds = collectSessionHierarchyIds(sessionId, sessionSummaries);
    for (const explicitSessionId of explicitChildSessionIds) {
      for (const collectedId of collectSessionHierarchyIds(explicitSessionId, sessionSummaries)) {
        hierarchySessionIds.add(collectedId);
      }
    }
    if (hierarchySessionIds.size > 1) {
      sawDelegatedHierarchy = true;
    }
    promotePendingUnscopedInterventions();

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

      const eventSessionId = properties.sessionID || properties.sessionId;

      if (payload.type === "question.asked" || payload.type === "permission.asked") {
        const candidate = {
          type: payload.type === "question.asked" ? "question_needed" : "permission_needed",
          sessionId: eventSessionId || sessionId
        };
        if (!isMonitoredEventSession(eventSessionId)) {
          if (eventSessionId) {
            pendingUnscopedInterventions.set(eventSessionId, candidate);
          }
          try {
            await refreshSessionHierarchy();
          } catch {
            // Ignore refresh failures; a later poll may still validate this candidate.
          }
          if (!isMonitoredEventSession(eventSessionId)) {
            return null;
          }
        }
        pendingIntervention = candidate;
        if (eventSessionId) {
          pendingUnscopedInterventions.delete(eventSessionId);
        }
        lastDirectoryActivityAt = Date.now();
        return null;
      }

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
            if (isMonitoredEventSession(eventSessionId)) {
              trackToolPartSnapshot(eventSessionId, partInfo, properties.partID || properties.messageID || "task");
            }
            if (partInfo.type === "tool" && isMonitoredEventSession(eventSessionId)) {
              const entry = buildToolTraceEntry(partInfo, eventSessionId, null);
              if (entry) {
                const displayEntry = eventSessionId && eventSessionId !== sessionId
                  ? { ...entry, label: `${eventSessionId} · ${entry.label}` }
                  : entry;
                const signature = buildTraceEntryKey(displayEntry);
                const toolPartKey = `${eventSessionId}:${partInfo.id || properties.partID || properties.messageID || "tool"}`;
                const priorSignature = printedToolSignatures.get(toolPartKey);
                const toolState = getToolPartState(partInfo);
                const toolExitCode = extractToolExitCode(partInfo);
                const shouldPrintToolEvent = !priorSignature
                  ? toolState !== "pending"
                  : toolState === "failed" || (toolState === "completed" && toolExitCode && toolExitCode !== "0" && priorSignature !== signature);
                if (shouldPrintToolEvent) {
                  printedToolSignatures.set(toolPartKey, signature);
                  printer.handleToolEvent(displayEntry);
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        if (payload.type === "message.part.delta") {
          if (properties.field === "text") {
            const knownType = properties.partID ? partTypes.get(properties.partID) : null;
            if (knownType === "reasoning") {
              if (eventSessionId === sessionId) {
                printer.handleReasoningDelta(properties.partID || properties.messageID || "reasoning", properties.delta);
              }
            } else if (knownType !== "tool" && eventSessionId === sessionId) {
              if (lastPrintedSessionId !== sessionId) {
                lastPrintedSessionId = sessionId;
              }
              printer.handleTextDelta(properties.delta);
            }
            if (isMonitoredEventSession(eventSessionId)) {
              for (const jobId of extractBackgroundJobIdsFromText(properties.delta)) {
                companionBackgroundJobIds.add(jobId);
              }
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
    let activeJobWaitLogged = false;

    while (!onSignalAbort.triggered) {
      await delay(SETTLING_CHECK_INTERVAL_MS);

      const now = Date.now();
      if (now - startTime > timeoutMs) {
        log(`Task timed out after ${timeoutMins} minutes.`);
        eventStreamController.abort();
        throw new Error(`Task timed out after ${timeoutMins} minutes.`);
      }

      const msSinceDirectoryActivity = now - lastDirectoryActivityAt;
      const shouldPollStatus = canUseStatusPolling() && now - lastStatusPollAt >= STATUS_POLL_INTERVAL_MS;

      if (shouldPollStatus) {
        lastStatusPollAt = now;
        try {
          await refreshSessionHierarchy();
          await reconcileMessageSnapshots([...hierarchySessionIds]);
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
      const blocker = await getMonitorBlocker({ pendingToolSessionIds });
      if (blocker?.type === "question_needed" || blocker?.type === "permission_needed") {
        return interventionResult(blocker.type);
      }
      if (blocker?.type === "active_task_tools") {
        if (!pendingToolWaitLogged) {
          log(`Detected pending native task tool call(s); continuing to wait...`);
          pendingToolWaitLogged = true;
        }
        continue;
      }
      if (blocker?.type === "active_companion_jobs") {
        if (!activeJobWaitLogged) {
          log(`Detected active companion background job(s): ${blocker.ids.join(", ")}; continuing to wait...`);
          activeJobWaitLogged = true;
        }
        continue;
      }
      activeJobWaitLogged = false;
      if (blocker?.type === "pending_tool_sessions") {
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
        printer.ensureLineBreak();
        log(`Finished (session status ${mainSessionStatus}) in directory ${directory}.`);
        return {
          done: true,
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "failed_root",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
      }

      if (hierarchyProgress.hasFailedDescendants) {
        printer.ensureLineBreak();
        log("Finished (descendant session status failed) in directory " + directory + ".");
        return {
          done: true,
          completionMode: "descendant_failed",
          terminalStatus: "failed",
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "descendant_failed",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
      }

      if (isMainSuccessfulTerminal && !hierarchyProgress.hasPendingDescendants) {
        printer.ensureLineBreak();
        log(`Finished (session status ${mainSessionStatus}) in directory ${directory}.`);
        return {
          done: true,
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "completed_tree",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
      }

      const hasSeenActivity = directorySessions.size > 0;
      const msSinceMainActivity = now - lastMainSessionActivityAt;
      const reachedQuiescenceFallback =
        hasSeenActivity &&
        !sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        msSinceMainActivity >= QUIESCENCE_TIMEOUT_MS;
      if (reachedQuiescenceFallback) {
        printer.ensureLineBreak();
        log(`Finished (quiescence) in directory ${directory}.`);
        return {
          done: true,
          completionMode: "quiescence",
          terminalStatus: "idle",
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "quiet_root",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
      }

      const reachedDelegatedFallback =
        hasSeenActivity &&
        sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        msSinceDirectoryActivity >= FORCE_QUIESCENCE_TIMEOUT_MS;
      if (reachedDelegatedFallback) {
        printer.ensureLineBreak();
        log(`Finished (settled after delegated activity) in directory ${directory}.`);
        return {
          done: true,
          completionMode: "delegated_settled",
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "quiet_delegated",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
      }
    }
    return { aborted: true };
  })();

  let streamResult = await Promise.race([eventStreamPromise, quiescencePromise]);
  if (streamResult.streamClosed) {
    log("Event stream closed before a terminal root status; reconciling via session polling...");
    let settleDeadline = null;
    let reconciledResult = null;
    let lastReconcileSnapshot = null;
    while (!onSignalAbort.triggered) {
      try {
        if (canUseStatusPolling()) {
          await refreshSessionHierarchy();
          await reconcileMessageSnapshots([...hierarchySessionIds]);
        }
      } catch {
        // Ignore polling errors while giving the server a brief chance to settle.
      }

      const now = Date.now();
      if (now - startTime > timeoutMs) {
        throw new Error(`Task timed out after ${timeoutMins} minutes.`);
      }
      if ((canUseStatusPolling() || directorySessions.size > 0) && settleDeadline == null) {
        settleDeadline = now + STREAM_CLOSE_GRACE_MS;
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
      let pendingToolSessionIds = [];
      if (hierarchyProgress.pendingSessionIds.length === 0) {
        pendingToolSessionIds = await findHierarchySessionsWithPendingToolCalls(
          baseUrl,
          directory,
          [...hierarchySessionIds]
        );
      }
      const blocker = await getMonitorBlocker({ pendingToolSessionIds });
      if (blocker?.type === "question_needed" || blocker?.type === "permission_needed") {
        reconciledResult = interventionResult(blocker.type);
        break;
      }
      if (blocker) {
        await delay(100);
        continue;
      }
      if (settleDeadline != null && now >= settleDeadline) {
        break;
      }
      const hasSeenActivity = directorySessions.size > 0;
      const msSinceMainActivity = now - lastMainSessionActivityAt;
      const msSinceDirectoryActivity = now - lastDirectoryActivityAt;
      lastReconcileSnapshot = {
        mainSessionStatus,
        hierarchyProgress,
        pendingToolSessionIds,
        hasSeenActivity,
        msSinceMainActivity,
        msSinceDirectoryActivity
      };

      if (isMainFailedTerminal) {
        reconciledResult = {
          done: true,
          completionMode: "terminal",
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "failed_root",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
        break;
      }
      if (hierarchyProgress.hasFailedDescendants) {
        reconciledResult = {
          done: true,
          completionMode: "descendant_failed",
          terminalStatus: "failed",
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "descendant_failed",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
        break;
      }
      if (isMainSuccessfulTerminal && !hierarchyProgress.hasPendingDescendants && pendingToolSessionIds.length === 0) {
        reconciledResult = {
          done: true,
          completionMode: "terminal",
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "completed_tree",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
        break;
      }
      if (
        hasSeenActivity &&
        !sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        pendingToolSessionIds.length === 0 &&
        msSinceMainActivity >= QUIESCENCE_TIMEOUT_MS
      ) {
        reconciledResult = {
          done: true,
          completionMode: "quiescence",
          terminalStatus: "idle",
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "quiet_root",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
        break;
      }
      if (
        hasSeenActivity &&
        sawDelegatedHierarchy &&
        hierarchyProgress.pendingSessionIds.length === 0 &&
        pendingToolSessionIds.length === 0 &&
        msSinceDirectoryActivity >= FORCE_QUIESCENCE_TIMEOUT_MS
      ) {
        reconciledResult = {
          done: true,
          completionMode: "delegated_settled",
          terminalStatus: mainSessionStatus,
          rawSessionStatus: mainSessionStatus,
          hierarchyVerdict: "quiet_delegated",
          hasPendingDescendants: hierarchyProgress.hasPendingDescendants,
          hasFailedDescendants: hierarchyProgress.hasFailedDescendants,
          pendingToolSessionIds
        };
        break;
      }

      await delay(100);
    }

    if (!reconciledResult && lastReconcileSnapshot) {
      try {
        const finalMessages = await listSessionMessages(baseUrl, directory, sessionId);
        const completionEvidence = inferCompletedAssistantReply(finalMessages);
        const pendingDescendants = lastReconcileSnapshot.hierarchyProgress?.hasPendingDescendants === true;
        const pendingToolSessionIds = Array.isArray(lastReconcileSnapshot.pendingToolSessionIds)
          ? lastReconcileSnapshot.pendingToolSessionIds
          : [];
        if (completionEvidence && !pendingDescendants && pendingToolSessionIds.length === 0) {
          log(
            `Recovered completion from persisted assistant reply after stream close${completionEvidence.finish ? ` (finish=${completionEvidence.finish})` : ""}.`
          );
          reconciledResult = {
            done: true,
            completionMode: "message_completion",
            terminalStatus: "completed",
            rawSessionStatus: lastReconcileSnapshot.mainSessionStatus,
            hierarchyVerdict: "message_completed",
            hasPendingDescendants: false,
            hasFailedDescendants: lastReconcileSnapshot.hierarchyProgress?.hasFailedDescendants === true,
            pendingToolSessionIds
          };
        }
      } catch {
        // Ignore message fetch failures and fall through to the original error.
      }
    }

    if (!reconciledResult) {
      throw new Error("OpenCode event stream ended before session completion.");
    }
    streamResult = reconciledResult;
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

  let sessionSummary = null;
  try {
    const sessions = await listSessions(baseUrl, directory);
    const session = sessions.find((entry) => summarizeSession(entry).id === sessionId) ?? null;
    sessionSummary = session ? summarizeSession(session) : null;
  } catch {
    // Usage/context metadata is best-effort; task result should still render without it.
  }
  
  const classifiedOutcome = classifySessionOutcome({
    sessionId,
    terminalStatus: streamResult.terminalStatus,
    rawSessionStatus: streamResult.rawSessionStatus ?? streamResult.terminalStatus,
    abortedBySignal,
    completionMode: streamResult.completionMode,
    hierarchyVerdict: streamResult.hierarchyVerdict,
    sawDelegatedHierarchy,
    hasPendingDescendants: streamResult.hasPendingDescendants ?? false,
    hasFailedDescendants: streamResult.hasFailedDescendants ?? false,
    pendingToolSessionIds: streamResult.pendingToolSessionIds ?? []
  });

  const result = buildTaskResult({
    directory,
    sessionId,
    messages,
    streamedText: printer.getOutput(),
    status: classifiedOutcome.status,
    completionMode: classifiedOutcome.completionMode,
    rawSessionStatus: classifiedOutcome.rawSessionStatus,
    hierarchyVerdict: classifiedOutcome.hierarchyVerdict,
    recommendedAction: classifiedOutcome.recommendedAction,
    sessionSummary
  });

  const recentTraceEntries = buildTraceEntriesFromMessages(messages, { sessionId, includeText: false, hierarchyContext: null });
  const recentTraceText = renderTraceEntriesAsText(recentTraceEntries);
  const streamedLength = printer.getEmittedOutput().trim().length;
  const displayText = !jobId && !printer.isLiveEmitting() && isSuccessfulResultStatus(result.status)
    ? (result.final_text || result.combined_text)
    : result.combined_text;
  const resultLength = (displayText || "").length;
  if (recentTraceText && !printer.hasTraceOutput()) {
    process.stdout.write(`\n${recentTraceText}\n`);
  }
  // Print combined_text if streaming missed significant content (>50% longer from API)
  // or if nothing was streamed at all
  if (displayText && (!streamedLength || resultLength > streamedLength * 1.5)) {
    process.stdout.write(`\n${displayText}\n`);
  }
  if (!jobId && !printer.isLiveEmitting() && isSuccessfulResultStatus(result.status)) {
    process.stdout.write(`\n${renderQuietCompletionHint(sessionId)}\n`);
  }
  process.stdout.write(renderTaskSummary(result));
  const resultIsSuccessful = isSuccessfulResultStatus(result.status);
  const resultIsFailed = isFailedResultStatus(result.status);
  if (jobId) {
    const finalPayload = {
      status: result.status,
      completionMode: result.completion_mode,
      rawSessionStatus: result.raw_session_status,
      hierarchyVerdict: result.hierarchy_verdict,
      combinedText: result.final_text,
      summary: summarizePrompt(result.final_text),
      error: resultIsFailed ? `OpenCode session ended with status ${result.status}.` : null
    };
    if (result.status === "completed") {
      markJobFinished(directory, jobId, "completed", {
        sessionId,
        model: rawModel,
        error: null,
        final: finalPayload
      });
    } else if (result.status === "delegated") {
      markJobFinished(directory, jobId, "delegated", {
        sessionId,
        model: rawModel,
        error: null,
        final: finalPayload
      });
    } else if (resultIsFailed) {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: `OpenCode session ended with status ${result.status}.`,
        final: finalPayload
      });
    } else {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: `OpenCode session settled without a terminal status (${result.status}).`,
        final: {
          ...finalPayload,
          error: `OpenCode session settled without a terminal status (${result.status}).`
        }
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
    stringFlags: [
      "--directory",
      "--server-directory",
      "--artifact-root",
      "--model",
      "--job-id",
      "--timeout",
      "--session",
      "--agent",
      "--prompt-file"
    ]
  });

  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const directory = resolveDirectory(options.directory);
  const prompt = readPrompt(positionals, options);
  if (!prompt) {
    throw new Error("Task prompt is required.");
  }

  if (options.background && options.async) {
    throw new Error("Cannot combine --background with --async.");
  }

  const rawModel = options.model == null ? null : String(options.model);
  const model = parseModelOption(options.model);
  const artifactRootOption = options["artifact-root"] ? String(options["artifact-root"]).trim() : null;
  const artifactRootDisplay = artifactRootOption || (process.env.OPENCODE_ARTIFACT_ROOT ? String(process.env.OPENCODE_ARTIFACT_ROOT).trim() : null);
  if (artifactRootOption) {
    process.env.OPENCODE_ARTIFACT_ROOT = artifactRootOption;
  }
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
    const entryScriptPath = fileURLToPath(import.meta.url);
    const backgroundJobId = generateJobId();
    const logFile = createJobLogFile(directory, backgroundJobId, { artifactRoot: artifactRootOption });
    appendLogLine(logFile, "Queued for background execution.");
    upsertJob(
      directory,
      buildJobRecord(directory, backgroundJobId, prompt, {
        status: "queued",
        model: rawModel,
        logFile,
        artifactRoot: artifactRootOption
      }),
      { artifactRoot: artifactRootOption }
    );
    recordJobEvent(directory, backgroundJobId, {
      type: "job.lifecycle",
      status: "queued",
      summary: "Queued for background execution.",
      activityKind: "job_queued"
    }, { artifactRoot: artifactRootOption });

    let child;
    try {
      child = spawnBackgroundTaskWorker(entryScriptPath, directory, backgroundJobId, prompt, {
        serverDirectory,
        artifactRoot: artifactRootOption,
        model: rawModel,
        agent: requestedAgent,
        timeout: timeoutMins
      });
    } catch (error) {
      markJobFinished(directory, backgroundJobId, "failed", {
        model: rawModel,
        error: error instanceof Error ? error.message : String(error),
        artifactRoot: artifactRootOption
      });
      throw error;
    }

    try {
      markJobRunning(directory, backgroundJobId, {
        pid: child.pid ?? null,
        model: rawModel,
        logFile,
        artifactRoot: artifactRootOption
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
        error: error instanceof Error ? error.message : String(error),
        artifactRoot: artifactRootOption
      });
      throw error;
    }

    process.stdout.write(renderBackgroundTaskStart(backgroundJobId, entryScriptPath, directory, artifactRootDisplay));
    return;
  }

  if (jobId) {
    const existing = readJob(directory, jobId, { artifactRoot: artifactRootOption });
    if (existing?.status === "cancelled") {
      return;
    }
    const logFile = existing?.logFile ?? createJobLogFile(directory, jobId, { artifactRoot: artifactRootOption });
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, "", "utf8");
    }
    const current = readJob(directory, jobId, { artifactRoot: artifactRootOption });
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
        sessionId: existing?.sessionId ?? null,
        artifactRoot: artifactRootOption ?? existing?.artifactRoot ?? null
      }),
      { artifactRoot: artifactRootOption ?? existing?.artifactRoot ?? null }
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
      const currentJob = readJob(directory, jobId, { artifactRoot: artifactRootOption });
      if (currentJob?.status === "cancelled") {
        log(`Job ${jobId} was cancelled before startup; exiting worker.`);
        return;
      }
      upsertJob(directory, {
        ...buildJobRecord(directory, jobId, prompt, {
          status: "running",
          startedAt: readJob(directory, jobId, { artifactRoot: artifactRootOption })?.startedAt ?? nowIso(),
          model: rawModel ?? null,
          pid: process.pid,
          sessionId,
          artifactRoot: artifactRootOption ?? currentJob?.artifactRoot ?? null
        }),
        sessionId,
        status: "running",
        pid: process.pid,
        error: null
      }, { artifactRoot: artifactRootOption ?? currentJob?.artifactRoot ?? null });
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
          error: null,
          artifactRoot: artifactRootOption
        });
      }
      return;
    }

    const printer = createTextStreamPrinter({ emitLive: Boolean(jobId) });
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
      const promptSubmitTimeoutMs = readEnvDurationMs("OPENCODE_PROMPT_SUBMIT_TIMEOUT_MS", 30000);
      await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        directory,
        body: buildTaskPayload(prompt, model, resolvedAgent),
        timeoutMs: promptSubmitTimeoutMs,
        signal: onSignalAbort.signal
      });
      taskLifecycle.promptSubmitted = true;
    } catch (error) {
      if (isAbortError(error) && !onSignalAbort.triggered) {
        log("Prompt submission timed out; checking session state in case OpenCode accepted the work...");
        taskLifecycle.promptSubmitted = true;
      } else {
        eventStreamController.abort();
        if (!onSignalAbort.triggered || !isAbortError(error)) {
          throw error;
        }
      }
    }

    const result = await monitorPromise;
    if (!result) {
      return;
    }
    if (!isSuccessfulResultStatus(result.status)) {
      process.exitCode = 1;
    }
    if (isSuccessfulResultStatus(result.status)) {
      shouldExit = true;
    }
  } catch (error) {
    if (isAbortError(error) && !onSignalAbort.triggered) {
      if (jobId) {
        markJobFinished(directory, jobId, "failed", {
          sessionId,
          model: rawModel,
          error: "OpenCode aborted the task request before it completed.",
          artifactRoot: artifactRootOption
        });
      }
      throw formatUnexpectedTaskAbort(model);
    }
    if (jobId) {
      markJobFinished(directory, jobId, "failed", {
        sessionId,
        model: rawModel,
        error: error instanceof Error ? error.message : String(error),
        artifactRoot: artifactRootOption
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
  if (hasHelpFlag(argv)) {
    printUsage("review");
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
    booleanFlags: ["--all", "--verbose"],
    stringFlags: ["--directory", "--server-directory", "--artifact-root"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const hierarchyContext = await tryGetLiveSessionHierarchyContext(serverDirectory, directory);
  const artifactRoot = options["artifact-root"] ? String(options["artifact-root"]).trim() : null;
  if (artifactRoot) {
    process.env.OPENCODE_ARTIFACT_ROOT = artifactRoot;
  }
  const jobId = positionals[0] ?? null;

  if (jobId) {
    const job = refreshStaleRunningJobs(directory, { artifactRoot }).find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      throw new Error(`No job found for ${jobId}.`);
    }
    const recentTraceEntries = job.sessionId
      ? await tryCollectLiveSessionTraceEntries(serverDirectory, directory, job.sessionId, hierarchyContext)
      : [];
    recordJobEvent(directory, jobId, buildJobLivenessEvent(job, hierarchyContext, recentTraceEntries), { artifactRoot: artifactRoot ?? job.artifactRoot ?? null });
    const snapshot = readJobSnapshot(directory, jobId, { artifactRoot: artifactRoot ?? job.artifactRoot ?? null });
    process.stdout.write(
      options.verbose
        ? buildVerboseJobStatusView(job, snapshot, hierarchyContext, recentTraceEntries)
        : buildDefaultJobStatusView(job, snapshot)
    );
    return;
  }

  process.stdout.write(buildJobListView(directory, { all: Boolean(options.all), verbose: Boolean(options.verbose), sessionHierarchyContext: hierarchyContext, artifactRoot }));
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--verbose"],
    stringFlags: ["--directory", "--server-directory", "--artifact-root"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const hierarchyContext = await tryGetLiveSessionHierarchyContext(serverDirectory, directory);
  const artifactRoot = options["artifact-root"] ? String(options["artifact-root"]).trim() : null;
  if (artifactRoot) {
    process.env.OPENCODE_ARTIFACT_ROOT = artifactRoot;
  }
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for result.");
  }

  const job = readJob(directory, jobId, { artifactRoot });
  if (!job) {
    throw new Error(`No job found for ${jobId}.`);
  }
  const recentTraceEntries = job.sessionId
    ? await tryCollectLiveSessionTraceEntries(serverDirectory, directory, job.sessionId, hierarchyContext)
    : [];
  if (recentTraceEntries.length > 0 || hierarchyContext) {
    recordJobEvent(directory, jobId, buildJobLivenessEvent(job, hierarchyContext, recentTraceEntries), { artifactRoot: artifactRoot ?? job.artifactRoot ?? null });
  }
  const snapshot = readJobSnapshot(directory, jobId, { artifactRoot: artifactRoot ?? job.artifactRoot ?? null });
  if (options.verbose) {
    process.stdout.write(buildVerboseJobStatusView(job, snapshot, hierarchyContext, recentTraceEntries));
    return;
  }
  process.stdout.write(buildQuietJobResult(job, snapshot));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    stringFlags: ["--directory", "--server-directory", "--artifact-root"]
  });
  const directory = resolveDirectory(options.directory);
  const artifactRoot = options["artifact-root"] ? String(options["artifact-root"]).trim() : null;
  if (artifactRoot) {
    process.env.OPENCODE_ARTIFACT_ROOT = artifactRoot;
  }
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Missing job id for cancel.");
  }

  const job = readJob(directory, jobId, { artifactRoot });
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
    error: null,
    artifactRoot: artifactRoot ?? job.artifactRoot ?? null
  }, { artifactRoot: artifactRoot ?? job.artifactRoot ?? null });

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
  const recentTraceEntries = await tryCollectLiveSessionTraceEntries(serverDirectory, directory, sessionId, hierarchyContext);
  process.stdout.write(buildSingleSessionView(directory, session, hierarchyContext, recentTraceEntries));
}

async function handleSessionCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage("session");
    return;
  }

  const usageTopicBySubcommand = {
    new: "session new",
    continue: "session continue",
    resume: "session continue",
    attach: "session attach",
    wait: "session wait",
    list: "session list",
    status: "session status"
  };

  const usageTopic = usageTopicBySubcommand[subcommand];
  if (!usageTopic) {
    throw new Error(`Unknown session command: ${subcommand}`);
  }
  if (hasHelpFlag(rest)) {
    printUsage(usageTopic);
    return;
  }

  if (subcommand === "new") {
    await handleTask(rest);
    return;
  }

  if (subcommand === "continue" || subcommand === "resume") {
    const { options, positionals } = parseArgs(rest, {
      booleanFlags: ["--async", "--background"],
      stringFlags: ["--directory", "--server-directory", "--artifact-root", "--model", "--timeout", "--prompt-file", "--agent"]
    });
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error(`Missing session id for session ${subcommand}.`);
    }
    const taskArgs = [];
    if (options.directory) taskArgs.push("--directory", String(options.directory));
    if (options["server-directory"]) taskArgs.push("--server-directory", String(options["server-directory"]));
    if (options["artifact-root"]) taskArgs.push("--artifact-root", String(options["artifact-root"]));
    if (options.model) taskArgs.push("--model", String(options.model));
    if (options.timeout) taskArgs.push("--timeout", String(options.timeout));
    if (options.agent) taskArgs.push("--agent", String(options.agent));
    if (options.async) taskArgs.push("--async");
    if (options.background) taskArgs.push("--background");
    if (options["prompt-file"]) taskArgs.push("--prompt-file", String(options["prompt-file"]));
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

}

async function handleServeCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage("serve");
    return;
  }

  const usageTopicBySubcommand = {
    start: "serve start",
    status: "serve status",
    stop: "serve stop"
  };
  const usageTopic = usageTopicBySubcommand[subcommand];
  if (!usageTopic) {
    throw new Error(`Unknown serve command: ${subcommand}`);
  }
  if (hasHelpFlag(rest)) {
    printUsage(usageTopic);
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
}

async function handleJobCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage("job");
    return;
  }

  const usageTopicBySubcommand = {
    list: "job list",
    status: "job status",
    wait: "job wait",
    result: "job result",
    cancel: "job cancel"
  };
  const usageTopic = usageTopicBySubcommand[subcommand];
  if (!usageTopic) {
    throw new Error(`Unknown job command: ${subcommand}`);
  }
  if (hasHelpFlag(rest)) {
    printUsage(usageTopic);
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
}

async function handleJobWait(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanFlags: ["--verbose"],
    stringFlags: ["--directory", "--server-directory", "--artifact-root", "--timeout"]
  });
  const directory = resolveDirectory(options.directory);
  const serverDirectory = resolveServerDirectory(options["server-directory"]);
  const artifactRoot = options["artifact-root"] ? String(options["artifact-root"]).trim() : null;
  if (artifactRoot) {
    process.env.OPENCODE_ARTIFACT_ROOT = artifactRoot;
  }
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
    const job = refreshStaleRunningJobs(directory, { artifactRoot }).find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      throw new Error(`No job found for ${jobId}.`);
    }
    if (!isActiveJob(job)) {
      const resultArgs = [jobId, "--directory", directory, "--server-directory", serverDirectory];
      if (artifactRoot) {
        resultArgs.push("--artifact-root", artifactRoot);
      }
      if (options.verbose) {
        resultArgs.push("--verbose");
      }
      await handleResult(resultArgs);
      return;
    }
    await delay(1500);
  }

  const statusArgs = [jobId, "--directory", directory, "--server-directory", serverDirectory];
  if (artifactRoot) {
    statusArgs.push("--artifact-root", artifactRoot);
  }
  if (options.verbose) {
    statusArgs.push("--verbose");
  }
  await handleStatus(statusArgs);
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

function isSameRealPath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

const isDirectExecution = isSameRealPath(process.argv[1] ?? "", fileURLToPath(import.meta.url));

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
  buildJobLivenessEvent,
  buildTaskResult,
  buildReviewPrompt,
  classifySessionOutcome,
  deriveResultStatus,
  formatReadableTimestamp,
  generateJobId,
  formatDuration,
  isSameRealPath,
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
