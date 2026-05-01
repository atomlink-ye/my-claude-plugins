import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  JOB_LOG_PREFIX,
  JOB_LOG_SUFFIX,
  JOB_PROMPT_PREFIX,
  JOB_PROMPT_SUFFIX,
  JOBS_FILE_NAME,
  PROMPT_INLINE_MAX_BYTES_DEFAULT,
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

export function jobsFilePath(directory) {
  return path.join(directory, JOBS_FILE_NAME);
}

export function jobLogFilePath(directory, jobId) {
  return path.join(directory, `${JOB_LOG_PREFIX}${jobId}${JOB_LOG_SUFFIX}`);
}

export function jobPromptFilePath(directory, jobId) {
  return path.join(directory, `${JOB_PROMPT_PREFIX}${jobId}${JOB_PROMPT_SUFFIX}`);
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

export function promptInlineMaxBytes() {
  return readEnvPositiveInt("OPENCODE_PROMPT_INLINE_MAX_BYTES", PROMPT_INLINE_MAX_BYTES_DEFAULT);
}
