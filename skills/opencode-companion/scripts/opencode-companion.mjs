#!/usr/bin/env node

import fs from "node:fs";
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
  jobLogFilePath,
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
  readJobs,
  readLogText,
  readLogTail,
  refreshStaleRunningJobs,
  renderBackgroundTaskStart,
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

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/opencode-companion.mjs serve start [--port N] [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs serve status [--server-directory SERVER_DIR]",
      "  node scripts/opencode-companion.mjs serve stop [--server-directory SERVER_DIR]",
      "",
      "  node scripts/opencode-companion.mjs session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- \"PROMPT\"]",
      "  node scripts/opencode-companion.mjs session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--agent NAME] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- \"PROMPT\"]",
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
        lines.push(`  Hierarchy: root ${hierarchyMetadata.rootSessionId} | verdict ${hierarchyMetadata.hierarchyVerdict} | sessions ${hierarchyMetadata.subtreeSummary.sessionCount} | ${formatHierarchyStatusCounts(hierarchyMetadata.subtreeSummary.statusCounts)} | latest ${formatReadableTimestamp(hierarchyMetadata.subtreeSummary.latestActivityLabel) || "-"} @ ${hierarchyMetadata.subtreeSummary.latestActivitySessionId || "-"}`);
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
  rawSessionStatus = status,
  hierarchyVerdict = null,
  recommendedAction = null
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
    hierarchy_verdict: hierarchyVerdict,
    recommended_action: recommendedAction,
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
  if (result.hierarchy_verdict) {
    lines.push(`Hierarchy verdict: ${result.hierarchy_verdict}`);
  }
  if (result.recommended_action) {
    lines.push(`Recommended action: ${result.recommended_action}`);
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
    `| created | ${escapeMarkdownCell(formatReadableTimestamp(details.createdAt))} |`,
    `| updated | ${escapeMarkdownCell(formatReadableTimestamp(details.updatedAt))} |`,
    `| last usage | ${escapeMarkdownCell(formatUsageSummary(details.lastUsage))} |`,
    `| total usage | ${escapeMarkdownCell(formatUsageSummary(details.totalUsage))} |`,
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
    "| tree | id | parent | raw | observed | updated | last usage | total usage | summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
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
      `| ${escapeMarkdownCell(treeLabel)} | ${escapeMarkdownCell(session.id)} | ${escapeMarkdownCell(session.parentId || "-")} | ${escapeMarkdownCell(session.status)} | ${escapeMarkdownCell(observedStatus)} | ${escapeMarkdownCell(formatReadableTimestamp(session.updatedAt || session.createdAt || ""))} | ${escapeMarkdownCell(formatUsageSummary(session.lastUsage))} | ${escapeMarkdownCell(formatUsageSummary(session.totalUsage))} | ${escapeMarkdownCell(session.summary)} |`
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
    while (!onSignalAbort.triggered) {
      try {
        if (canUseStatusPolling()) {
          await refreshSessionHierarchy();
        }
      } catch {
        // Ignore polling errors while giving the server a brief chance to settle.
      }

      const now = Date.now();
      if ((canUseStatusPolling() || directorySessions.size > 0) && settleDeadline == null) {
        settleDeadline = now + STREAM_CLOSE_GRACE_MS;
      }
      if (settleDeadline != null && now >= settleDeadline) {
        break;
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
      const hasSeenActivity = directorySessions.size > 0;
      const msSinceMainActivity = now - lastMainSessionActivityAt;
      const msSinceDirectoryActivity = now - lastDirectoryActivityAt;

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
    recommendedAction: classifiedOutcome.recommendedAction
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
    stringFlags: [
      "--directory",
      "--server-directory",
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
      child = spawnBackgroundTaskWorker(entryScriptPath, directory, backgroundJobId, prompt, {
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

    process.stdout.write(renderBackgroundTaskStart(backgroundJobId, entryScriptPath, directory));
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
      stringFlags: ["--directory", "--server-directory", "--model", "--timeout", "--prompt-file"]
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
  classifySessionOutcome,
  deriveResultStatus,
  formatReadableTimestamp,
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
