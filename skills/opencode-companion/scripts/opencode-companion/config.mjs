import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_ARTIFACT_ROOT,
  JOB_COMPAT_LOG_FILE_NAME,
  JOB_EVENTS_FILE_NAME,
  JOB_PROMPT_FILE_NAME,
  JOBS_DIR_NAME,
  JOB_LOG_PREFIX,
  JOBS_FILE_NAME,
  JOB_SNAPSHOT_MARKDOWN_FILE_NAME,
  JOB_SNAPSHOT_STATE_FILE_NAME,
  PROMPT_INLINE_MAX_BYTES_DEFAULT_POSIX,
  PROMPT_INLINE_MAX_BYTES_DEFAULT_WIN32,
  RUNTIME_STATE_DIR_NAME,
  STATE_FILE_NAME
} from "./constants.mjs";

export function readEnvDurationMs(name, fallbackMs) {
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

export function parseArgs(argv, { booleanFlags = [], stringFlags = [] } = {}) {
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

export function resolveValidDirectory(resolved) {
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
export function resolveServerDirectory(input) {
  return resolveValidDirectory(path.resolve(input ?? os.homedir()));
}

// Working directory: the project context sent to OpenCode sessions.
export function resolveDirectory(input) {
  return resolveValidDirectory(path.resolve(input ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
}

export function stateFilePath(directory) {
  return path.join(directory, STATE_FILE_NAME);
}

export function runtimeStateDirectory(directory) {
  return path.join(directory, RUNTIME_STATE_DIR_NAME);
}

export function resolveArtifactRoot(directory, input = null) {
  const rawInput = input == null || String(input).trim() === ""
    ? process.env.OPENCODE_ARTIFACT_ROOT ?? DEFAULT_ARTIFACT_ROOT
    : input;
  return path.resolve(directory, String(rawInput));
}

export function jobsDirectoryPath(directory, artifactRoot = null) {
  return path.join(resolveArtifactRoot(directory, artifactRoot), JOBS_DIR_NAME);
}

export function jobsFilePath(directory, artifactRoot = null) {
  return path.join(jobsDirectoryPath(directory, artifactRoot), JOBS_FILE_NAME);
}

export function jobDirectoryPath(directory, jobId, artifactRoot = null) {
  return path.join(jobsDirectoryPath(directory, artifactRoot), jobId);
}

export function jobEventsFilePath(directory, jobId, artifactRoot = null) {
  return path.join(jobDirectoryPath(directory, jobId, artifactRoot), JOB_EVENTS_FILE_NAME);
}

export function jobSnapshotStateFilePath(directory, jobId, artifactRoot = null) {
  return path.join(jobDirectoryPath(directory, jobId, artifactRoot), JOB_SNAPSHOT_STATE_FILE_NAME);
}

export function jobSnapshotMarkdownFilePath(directory, jobId, artifactRoot = null) {
  return path.join(jobDirectoryPath(directory, jobId, artifactRoot), JOB_SNAPSHOT_MARKDOWN_FILE_NAME);
}

export function jobCompatLogFilePath(directory, jobId, artifactRoot = null) {
  return path.join(jobDirectoryPath(directory, jobId, artifactRoot), JOB_COMPAT_LOG_FILE_NAME);
}

export function jobPromptFilePath(directory, jobId, artifactRoot = null) {
  return path.join(jobDirectoryPath(directory, jobId, artifactRoot), JOB_PROMPT_FILE_NAME);
}

// Legacy helpers kept only for compatibility reads/migrations.
export function legacyJobsFilePath(directory) {
  return path.join(directory, `${JOB_LOG_PREFIX.replace(/-$/, "")}s.json`);
}

export function legacyJobLogFilePath(directory, jobId) {
  return path.join(directory, `${JOB_LOG_PREFIX}${jobId}.log`);
}

export function readEnvPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

export function promptInlineMaxBytesDefault() {
  return process.platform === "win32"
    ? PROMPT_INLINE_MAX_BYTES_DEFAULT_WIN32
    : PROMPT_INLINE_MAX_BYTES_DEFAULT_POSIX;
}

export function promptInlineMaxBytes() {
  return readEnvPositiveInt("OPENCODE_PROMPT_INLINE_MAX_BYTES", promptInlineMaxBytesDefault());
}
