#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { getActiveBinding, readConfig, removeBinding, resolveBinding, upsertBinding } from "../project-config.mjs";
import { parseArgs as parseArgsGeneric, parseDurationMs, redactStateForDisplay, sanitizeTaskId, shellQuote } from "../lib/cli-shared.mjs";
import {
  assertNoControlArchiveEntries,
  assertRemoteCommandSuccess,
  assertSafeRemoteTransferPath,
  createBundle,
  listTarEntries,
  mergeTransferTree,
  prepareTransferOutput,
  remoteResultText,
  resolveRemoteTransferPath as resolveRemoteTransferPathViaExec,
  runTar,
  stripRemoteShellWarnings,
  validateTarEntries,
} from "../lib/transfer.mjs";
import { createGitBundle, fetchGitBundleIntoBranch, listGitBundle, remoteEnsureGitCommand, runLocal, validateGitBranch } from "../lib/git-sync.mjs";

const BOOL_FLAGS = ["--help", "--refresh", "--keep-state", "--include-git", "--include-preview", "--ephemeral", "--no-use", "--include-sensitive", "--overwrite", "--committed-only", "--require-clean"];
const STRING_FLAGS = ["--directory", "--state-directory", "--task-id", "--snapshot", "--name", "--env-file", "--path", "--remote-path", "--mode", "--cwd", "--output", "--artifacts", "--sandbox", "--sandbox-id", "--sandbox-name", "--class", "--cpu", "--memory", "--disk", "--gpu", "--branch", "--port", "--expires-in", "--auto-stop", "--auto-archive", "--auto-delete", "--timeout"];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const DEFAULT_STATE_ROOT = path.join(homedir(), ".daytona", "claude-code");
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;

function formatDurationMs(value) {
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}
const CLASS_RESOURCE_DEFAULTS = {
  small: { cpu: 1, memory: 1, disk: 3, gpu: 0 },
};

/** Daytona's flag surface is fixed (BOOL_FLAGS/STRING_FLAGS); the parsing engine itself lives in lib/cli-shared.mjs so other adapters can reuse it with their own flag lists. */
function parseArgs(argv = process.argv.slice(2), config = { booleanFlags: BOOL_FLAGS, stringFlags: STRING_FLAGS }) {
  return parseArgsGeneric(argv, config);
}

function parseResourceNumber(value, source) {
  if (value === undefined) return undefined;
  const number = Number(value);
  const min = source === "gpu" ? 0 : Number.MIN_VALUE;
  if (!Number.isFinite(number) || number < min) throw new Error(`Invalid ${source}: expected ${source === "gpu" ? "a non-negative" : "a positive"} number`);
  return number;
}

function parsePositiveInteger(value, source) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Invalid ${source}: expected a positive integer`);
  return number;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port: expected integer 1-65535");
  return port;
}

function validateSandboxClass(value) {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (!["small", "medium", "large"].includes(normalized)) throw new Error("Invalid class: expected small, medium, or large");
  return normalized;
}

function collectResources(options = {}) {
  const resources = {};
  for (const key of ["cpu", "memory", "disk", "gpu"]) {
    const parsed = parseResourceNumber(options[key], key);
    if (parsed !== undefined) resources[key] = parsed;
  }
  const sandboxClass = validateSandboxClass(options.class);
  if (!Object.keys(resources).length && sandboxClass && CLASS_RESOURCE_DEFAULTS[sandboxClass]) return { ...CLASS_RESOURCE_DEFAULTS[sandboxClass] };
  return Object.keys(resources).length ? resources : undefined;
}

function hasExplicitResourceFlags(options = {}) {
  return ["cpu", "memory", "disk", "gpu"].some((key) => options[key] !== undefined);
}

function normalizeRemoteHome(remoteHome) {
  if (remoteHome === undefined || remoteHome === null || remoteHome === "") return undefined;
  const normalized = path.posix.normalize(String(remoteHome).replaceAll("\\", "/"));
  if (!normalized.startsWith("/") || normalized === "/" || normalized.split("/").includes("..") || /\s/.test(normalized)) {
    throw new Error(`Invalid remote home: ${remoteHome}`);
  }
  return normalized;
}

function toRemoteAbsolute(remotePath, remoteHome = process.env.DAYTONA_REMOTE_HOME) {
  const normalized = String(remotePath ?? "").replaceAll("\\", "/");
  if (!normalized) throw new Error("Remote path must not be empty");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) throw new Error(`Unsafe remote path rejected: ${remotePath}`);
  const base = normalizeRemoteHome(remoteHome);
  if (!normalized.startsWith("/") && !base) {
    throw new Error("Relative remote paths require a remote home; resolve sandbox $HOME or set DAYTONA_REMOTE_HOME");
  }
  const absolute = normalized.startsWith("/") ? path.posix.normalize(normalized) : path.posix.normalize(path.posix.join(base, normalized));
  return absolute;
}

function assertSafeDestructiveRemoteWorkspace(remotePath, remoteHome = process.env.DAYTONA_REMOTE_HOME) {
  const absolute = toRemoteAbsolute(remotePath, remoteHome);
  const home = normalizeRemoteHome(remoteHome);
  const allowed = home ? [`${home}/workspace/`, "/workspace/"] : ["/workspace/"];
  const blocked = ["/", "/home", home, home ? `${home}/workspace` : undefined, "/workspace", "/tmp"].filter(Boolean);
  if (!allowed.some((prefix) => absolute.startsWith(prefix)) || blocked.includes(absolute)) {
    throw new Error(`Refusing destructive operation on unsafe remote path: ${absolute}`);
  }
  return absolute;
}

async function resolveRemoteHome(sandbox) {
  const commands = [
    "printf '%s\\n' \"${HOME:-}\"",
    "command -v getent >/dev/null 2>&1 && getent passwd \"$(id -u)\" | cut -d: -f6",
    "[ -r /etc/passwd ] && awk -F: -v uid=\"$(id -u)\" '$3 == uid { print $6; exit }' /etc/passwd",
    "user=$(id -un 2>/dev/null || whoami 2>/dev/null || true); [ -n \"$user\" ] && [ -d \"/home/$user\" ] && printf '%s\\n' \"/home/$user\"",
    "for d in /home/*; do [ -d \"$d\" ] && printf '%s\\n' \"$d\" && break; done",
    "[ \"$(id -u)\" = 0 ] && [ -d /root ] && printf '%s\\n' /root",
  ];
  for (const command of commands) {
    const result = await sandboxExec(sandbox, `sh -lc ${shellQuote(command)}`);
    if (typeof result?.exitCode === "number" && result.exitCode !== 0) continue;
    const output = result?.stdout ?? result?.output ?? result?.result ?? result?.data ?? result?.artifacts?.stdout ?? "";
    for (const line of String(output).split(/\r?\n/)) {
      const remoteHome = line.trim();
      if (!remoteHome || /warning:|cannot change locale/i.test(remoteHome)) continue;
      try {
        const normalized = normalizeRemoteHome(remoteHome);
        if (normalized) return normalized;
      } catch {
        continue;
      }
    }
  }
  throw new Error("Could not determine sandbox remote home from environment or passwd database");
}

function resolveProjectPaths(options = {}) {
  const directory = path.resolve(options.directory ?? process.cwd());
  const stateRoot = path.resolve(options["state-directory"] ?? process.env.DAYTONA_STATE_DIR ?? DEFAULT_STATE_ROOT);
  const projectKey = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  const stateDir = path.join(stateRoot, "projects");
  const stateFile = path.join(stateDir, `${projectKey}.json`);
  const legacyStateDir = path.join(directory, ".daytona");
  const legacyStateFile = path.join(legacyStateDir, "state.json");
  const config = readConfig(directory);
  const explicitSandbox = options.sandbox ?? options["sandbox-name"] ?? options["sandbox-id"];
  const binding = explicitSandbox
    ? resolveBinding(config ?? { sandboxes: {} }, explicitSandbox)
    : options.ignoreActiveBinding ? null : getActiveBinding(directory);
  if (explicitSandbox && !binding && !options.allowUnboundSandboxRef) throw new Error(`Sandbox binding not found: ${explicitSandbox}`);
  const state = options.ignoreState ? null : (readState(stateFile) ?? (!options.ignoreLegacyState ? readState(legacyStateFile) : null));
  const rawTaskId = options["task-id"] ?? state?.taskId;
  const defaultTaskId = path.basename(directory).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const taskId = sanitizeTaskId(rawTaskId ?? defaultTaskId, rawTaskId === undefined ? "default task id" : "task id");
  const remoteWorkspacePath = `workspace/${taskId}`;
  const remoteArtifactsPath = `artifacts/daytona/${taskId}`;
  const localArtifactsPath = path.join(directory, "artifacts", "daytona", taskId);
  const localArtifactsRelative = path.relative(directory, localArtifactsPath);
  if (localArtifactsRelative.startsWith("..") || path.isAbsolute(localArtifactsRelative)) {
    throw new Error("Resolved local artifacts path escapes project directory");
  }
  const resolvedSandboxId = options.sandboxId ?? options["sandbox-id"] ?? binding?.sandboxId ?? state?.sandboxId;
  const resolvedRemoteWorkspace = options.remoteWorkspace ?? options["remote-path"] ?? binding?.remoteWorkspace ?? state?.remoteWorkspacePath ?? remoteWorkspacePath;
  return { directory, stateRoot, stateDir, stateFile, legacyStateDir, legacyStateFile, ignoreLegacyState: Boolean(options.ignoreLegacyState), projectKey, taskId, remoteWorkspacePath: resolvedRemoteWorkspace, remoteArtifactsPath: state?.remoteArtifactsPath ?? remoteArtifactsPath, localArtifactsPath, config, binding, sandboxId: resolvedSandboxId };
}

function projectIdentity(directory) {
  directory = directory ?? process.cwd();
  let resolved;
  try { resolved = realpathSync(directory); } catch { resolved = path.resolve(directory); }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

function loadEnvFile(filePath) {
  if (!filePath) return {};
  const envPath = path.resolve(filePath);
  if (!existsSync(envPath)) throw new Error(`Env file not found: ${envPath}`);
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

function resolveEnvFile(options = {}, paths = resolveProjectPaths(options), { globalStateRoot = DEFAULT_STATE_ROOT } = {}) {
  if (options["env-file"]) return path.resolve(options["env-file"]);
  const projectEnvFile = path.join(paths.directory, ".env.local");
  if (existsSync(projectEnvFile)) return projectEnvFile;
  const resolvedGlobalStateRoot = path.resolve(globalStateRoot);
  const customStateEnvFile = path.join(paths.stateRoot, ".env.local");
  if (paths.stateRoot !== resolvedGlobalStateRoot && existsSync(customStateEnvFile)) return customStateEnvFile;
  const globalEnvFile = path.join(resolvedGlobalStateRoot, ".env.local");
  return existsSync(globalEnvFile) ? globalEnvFile : null;
}

function resolveEnvFiles(options = {}, paths = resolveProjectPaths(options), { globalStateRoot = DEFAULT_STATE_ROOT } = {}) {
  if (options["env-file"]) return [path.resolve(options["env-file"])];
  const files = [];
  const resolvedGlobalStateRoot = path.resolve(globalStateRoot);
  const globalEnvFile = path.join(resolvedGlobalStateRoot, ".env.local");
  const customStateEnvFile = path.join(paths.stateRoot, ".env.local");
  const projectEnvFile = path.join(paths.directory, ".env.local");
  if (existsSync(globalEnvFile)) files.push(globalEnvFile);
  if (paths.stateRoot !== resolvedGlobalStateRoot && existsSync(customStateEnvFile)) files.push(customStateEnvFile);
  if (existsSync(projectEnvFile)) files.push(projectEnvFile);
  return files;
}

function applyDaytonaEnv(env = {}) {
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  if (!process.env.DAYTONA_API_KEY && process.env.DAYTONA_API_TOKEN) process.env.DAYTONA_API_KEY = process.env.DAYTONA_API_TOKEN;
}

function applyProjectEnv(options = {}, paths = resolveProjectPaths(options), envConfig = {}) {
  const env = {};
  for (const envFile of resolveEnvFiles(options, paths, envConfig)) Object.assign(env, loadEnvFile(envFile));
  applyDaytonaEnv(env);
}

function recoveryActions(directory, sandboxId, remoteWorkspacePath) {
  const name = `recovery-${String(sandboxId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  return [
    `sandbox-ctl adopt --directory ${shellQuote(directory)} --sandbox-id ${shellQuote(sandboxId)} --name ${shellQuote(name)} --remote-path ${shellQuote(remoteWorkspacePath)}`,
    `sandbox-ctl down --directory ${shellQuote(directory)} --sandbox ${shellQuote(name)}`,
  ];
}

function buildUsage() {
  return [
    "Usage: node scripts/daytona-manager.mjs <command> [options]",
    "",
    "Commands:",
    "  up [--directory DIR] [--state-directory DIR] [--task-id ID] [--snapshot SNAPSHOT] [--name NAME] [--class small|medium|large] [--cpu N --memory GB --disk GB --gpu N] [--env-file FILE]",
    "  adopt [--directory DIR] [--state-directory DIR] [--task-id ID] (--sandbox-id ID | --sandbox-name NAME) [--remote-path PATH] [--env-file FILE]",
    "  status [--directory DIR] [--state-directory DIR] [--refresh] [--env-file FILE]",
    "  push [LOCAL_PATH] [--directory DIR] [--state-directory DIR] [--task-id ID] [--path PATH] [--remote-path PATH] [--mode bundle|full|git] [--include-sensitive] [--branch BRANCH] [--committed-only|--require-clean]",
    "  exec [--directory DIR] [--state-directory DIR] [--cwd PATH] [--artifacts PATH] [--timeout DURATION] -- COMMAND...",
    "  pull [REMOTE_PATH] [--directory DIR] [--state-directory DIR] [--output DIR] [--remote-path PATH] [--mode bundle|full|git] [--include-sensitive] [--overwrite] [--branch BRANCH]",
    "  preview [--directory DIR] [--state-directory DIR] --port PORT [--expires-in SECONDS]",
    "  smoke-test [--directory DIR] [--state-directory DIR] [--task-id ID] [--class small|medium|large] [--include-git] [--include-preview]",
    "  down [--directory DIR] [--state-directory DIR] [--keep-state] [--env-file FILE]",
    "",
    "State defaults to ~/.daytona/claude-code/projects/<project-hash>.json keyed by --directory or cwd. Bundle mode syncs files/artifacts; git mode syncs committed Git history into a local branch."
  ].join("\n");
}

function readState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function writeState(paths, state) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function readProjectState(paths) {
  return readProjectStateWithSource(paths).state;
}

function readProjectStateWithSource(paths) {
  const primary = readState(paths.stateFile);
  if (primary) return { state: primary, source: paths.stateFile };
  if (!paths.ignoreLegacyState) {
    const legacy = readState(paths.legacyStateFile);
    if (legacy) return { state: legacy, source: paths.legacyStateFile };
  }
  return { state: null, source: null };
}

function writeProvisionalSandboxState(paths, sandbox) {
  const sandboxId = sandbox?.id ?? sandbox?.sandboxId ?? sandbox?.instanceId;
  if (!sandboxId) return null;
  const state = { projectDirectory: paths.directory, taskId: paths.taskId, sandboxId, remoteWorkspacePath: paths.remoteWorkspacePath, remoteArtifactsPath: paths.remoteArtifactsPath };
  writeState(paths, state);
  return state;
}

function removeStateSource(paths, source) {
  if (source === paths.stateFile) rmSync(paths.stateFile, { force: true });
  if (source === paths.legacyStateFile) rmSync(paths.legacyStateFile, { force: true });
}

function migrateLegacyStateToConfig(paths, state) {
  if (!state?.sandboxId || paths.binding) return paths.binding ?? null;
  const name = state.sandboxName ?? state.name ?? state.taskId ?? (path.basename(paths.directory).replace(/[^A-Za-z0-9._-]+/g, "-") || "sandbox");
  const binding = upsertBinding(paths.directory, name, {
    sandboxId: state.sandboxId,
    projectIdentity: state.projectIdentity ?? state.labels?.["sandbox-ctl.project"] ?? projectIdentity(paths.directory),
    legacyIdentity: state.taskId ? { taskId: state.taskId, projectIdentity: projectIdentity(paths.directory) } : undefined,
    snapshot: state.snapshot,
    remoteWorkspace: state.remoteWorkspacePath ?? paths.remoteWorkspacePath,
    lifecycle: state.lifecycle,
    sync: state.syncMode ? { mode: state.syncMode, branch: state.gitBranch } : undefined,
    name: state.sandboxName,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
  }, { use: true });
  return binding;
}

function buildSandboxCreateParams(options = {}, paths = {}) {
  const numericOption = (value, source) => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error(`Invalid ${source}: expected an integer`);
    return number;
  };
  const labels = {
    ...(options.labels ?? {}),
    "sandbox-ctl.managed": "true",
    "sandbox-ctl.kind": "sandbox",
    "sandbox-ctl.adapter": "daytona",
    "sandbox-ctl.policy": "sandbox-v1",
    "sandbox-ctl.project": projectIdentity(paths.directory),
    taskId: paths.taskId,
  };
  const params = {
    name: options.name,
    snapshot: options.snapshot,
    resources: collectResources(options),
    labels,
    autoStopInterval: numericOption(options.autoStopInterval ?? options["auto-stop"], "auto-stop"),
    autoArchiveInterval: numericOption(options.autoArchiveInterval ?? options["auto-archive"], "auto-archive"),
    autoDeleteInterval: numericOption(options.autoDeleteInterval ?? options["auto-delete"], "auto-delete"),
    ephemeral: options.ephemeral,
  };
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  return params;
}

function sandboxLabels(sandbox) {
  return sandbox?.labels ?? sandbox?.metadata?.labels ?? sandbox?.info?.labels ?? {};
}

function assertManagedSandbox(sandbox, expectedKind = "sandbox", expectedLifecycle, expectedTaskId, expectedProjectIdentity, legacyIdentity) {
  const labels = sandboxLabels(sandbox);
  if (String(labels["sandbox-ctl.managed"]) !== "true") throw new Error("Refusing operation on unmanaged sandbox");
  const kind = labels["sandbox-ctl.kind"];
  const policy = labels["sandbox-ctl.policy"];
  const legacy = ["task", "project"].includes(kind) && policy === `${kind}-v1`;
  if (kind !== expectedKind && !(expectedKind === "sandbox" && legacy)) throw new Error(`Sandbox kind mismatch: expected ${expectedKind}`);
  if (policy !== "sandbox-v1" && !legacy) throw new Error("Sandbox policy mismatch: expected sandbox-v1");
  if (expectedTaskId !== undefined && String(labels.taskId) !== String(expectedTaskId)) throw new Error("Sandbox taskId mismatch");
  if (expectedProjectIdentity !== undefined && String(labels["sandbox-ctl.project"]) !== String(expectedProjectIdentity)) {
    if (!legacy || !legacyIdentity || String(labels.taskId) !== String(legacyIdentity.taskId)) throw new Error("Sandbox project identity mismatch");
  }
  if (expectedLifecycle) {
    for (const key of ["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval"]) {
      if (expectedLifecycle[key] === undefined) continue;
      const actual = sandbox?.[key] ?? sandbox?.info?.[key] ?? sandbox?.configuration?.[key];
      if (String(actual) !== String(expectedLifecycle[key])) throw new Error(`Sandbox lifecycle mismatch: ${key}`);
    }
    if (expectedLifecycle.ephemeral && String(expectedLifecycle.autoDeleteInterval) !== "0") throw new Error("Sandbox lifecycle mismatch: ephemeral");
  }
  return sandbox;
}

async function createSandboxWithFallback(client, params, options = {}) {
  try { return await callFirst(client, ["create", "createSandbox"], params); }
  catch (error) {
    if (!params.resources || hasExplicitResourceFlags(options)) throw error;
    const fallbackParams = { ...params };
    delete fallbackParams.resources;
    return callFirst(client, ["create", "createSandbox"], fallbackParams);
  }
}

async function loadDaytonaSdk() {
  try {
    return await import("@daytona/sdk");
  } catch (directImportError) {
    const fallbackRoots = [
      process.env.DAYTONA_SDK_MODULE_ROOT,
      path.join(homedir(), ".claude", "plugins", "marketplaces", "my-claude-plugins"),
    ].filter(Boolean);
    for (const root of fallbackRoots) {
      try {
        return createRequire(path.join(root, "package.json"))("@daytona/sdk");
      } catch {}
    }
    throw new Error(`Daytona SDK is required for this command. Install it with: pnpm add @daytona/sdk (or install plugin dependencies). Original error: ${directImportError?.message ?? directImportError}`);
  }
}

async function createClient() {
  const sdk = await loadDaytonaSdk();
  const Daytona = sdk.Daytona ?? sdk.default?.Daytona ?? sdk.default;
  if (!Daytona) throw new Error("Could not find Daytona client export in @daytona/sdk.");
  const options = {};
  if (process.env.DAYTONA_API_KEY) options.apiKey = process.env.DAYTONA_API_KEY;
  if (process.env.DAYTONA_JWT_TOKEN) options.jwtToken = process.env.DAYTONA_JWT_TOKEN;
  if (process.env.DAYTONA_ORGANIZATION_ID) options.organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  if (process.env.DAYTONA_API_URL) options.apiUrl = process.env.DAYTONA_API_URL;
  else if (process.env.DAYTONA_SERVER_URL) options.serverUrl = process.env.DAYTONA_SERVER_URL;
  if (process.env.DAYTONA_TARGET) options.target = process.env.DAYTONA_TARGET;
  // Passing only apiKey disables the SDK's env fallback for apiUrl/target in some SDK versions.
  // Pass every known Daytona env setting explicitly so CLI-created EU/US sandboxes resolve the same way.
  return Object.keys(options).length ? new Daytona(options) : new Daytona();
}

function getErrorStatus(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? error?.cause?.response?.status;
}

function isNotFoundError(error) {
  const status = getErrorStatus(error);
  if (status === 404) return true;
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("not found") || message.includes("404");
}

function describeDaytonaError(error) {
  const status = getErrorStatus(error);
  const parts = [];
  if (status) parts.push(`status=${status}`);
  if (error?.name) parts.push(`name=${error.name}`);
  if (error?.message) parts.push(`message=${error.message}`);
  return parts.length ? parts.join(" ") : String(error);
}

async function callFirst(target, names, ...args) {
  for (const name of names) if (target && typeof target[name] === "function") return target[name](...args);
  throw new Error(`Daytona SDK object does not expose any of: ${names.join(", ")}`);
}

function sandboxIdentity(sandbox) {
  return {
    id: sandbox?.id ?? sandbox?.sandboxId ?? sandbox?.instanceId,
    name: sandbox?.name ?? sandbox?.info?.name,
  };
}

async function findSandboxByList(client, sandboxRef) {
  if (typeof client?.list !== "function") return null;
  const sandboxes = await client.list();
  const items = Array.isArray(sandboxes) ? sandboxes : (sandboxes?.items ?? sandboxes?.data ?? []);
  return items.find((sandbox) => {
    const { id, name } = sandboxIdentity(sandbox);
    return id === sandboxRef || name === sandboxRef;
  }) ?? null;
}

async function getSandbox(client, sandboxRef, { allowNotFound = true } = {}) {
  if (!sandboxRef) return null;
  try {
    const sandbox = await callFirst(client, ["get", "getSandbox", "findSandbox"], sandboxRef);
    if (sandbox) return sandbox;
    const listed = await findSandboxByList(client, sandboxRef);
    if (listed) return listed;
    if (allowNotFound) return null;
    throw new Error(`Sandbox not found or unavailable: ${sandboxRef}`);
  } catch (error) {
    if (!isNotFoundError(error)) throw new Error(`Daytona SDK failed to load sandbox ${sandboxRef}: ${describeDaytonaError(error)}`);
    try {
      const listed = await findSandboxByList(client, sandboxRef);
      if (listed) return listed;
    } catch (listError) {
      if (!isNotFoundError(listError)) throw new Error(`Daytona SDK failed to list sandboxes after ${sandboxRef} lookup miss: ${describeDaytonaError(listError)}`);
    }
    if (allowNotFound) return null;
    throw new Error(`Sandbox not found or unavailable: ${sandboxRef}`);
  }
}

function sandboxState(sandbox) {
  return String(sandbox?.state ?? sandbox?.status ?? sandbox?.info?.status ?? "").toLowerCase();
}

async function ensureSandboxStarted(sandbox) {
  const state = sandboxState(sandbox);
  if (!state || ["started", "running"].includes(state)) return sandbox;
  if (typeof sandbox.start === "function") await sandbox.start();
  else throw new Error(`Sandbox is ${state} and this @daytona/sdk version does not expose sandbox.start().`);
  if (typeof sandbox.waitUntilStarted === "function") await sandbox.waitUntilStarted();
  if (typeof sandbox.refreshDataSafe === "function") await sandbox.refreshDataSafe();
  else if (typeof sandbox.refreshData === "function") await sandbox.refreshData();
  return sandbox;
}

async function sandboxExec(sandbox, command, cwd) {
  if (sandbox.process?.executeCommand) return sandbox.process.executeCommand(command, cwd);
  if (sandbox.process?.exec) return sandbox.process.exec(command, cwd ? { cwd } : undefined);
  if (sandbox.exec) return sandbox.exec(command, cwd ? { cwd } : undefined);
  throw new Error("Sandbox command execution is not supported by this @daytona/sdk version.");
}

function sessionProcessApi(sandbox) {
  const processApi = sandbox?.process;
  if (!processApi) return null;
  const names = ["createSession", "executeSessionCommand", "getSessionCommandLogs", "getSessionCommand", "deleteSession"];
  return names.every((name) => typeof processApi[name] === "function") ? processApi : null;
}

function newExecSessionId() {
  return `sandbox-ctl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sessionCall(processApi, name, canonicalArgs, objectArg) {
  const method = processApi[name];
  // The SDK uses (sessionId, request, ...), while small test doubles and older
  // wrappers sometimes expose a single request object. Support both shapes.
  if (method.length === 1 && objectArg !== undefined) return method.call(processApi, objectArg);
  return method.call(processApi, ...canonicalArgs);
}

function remoteExitCode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
}

function redactExecFailure(error) {
  let message = String(error?.message ?? error);
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_KEY_RE.test(key) && value && value.length > 3) message = message.split(value).join("[redacted]");
  }
  return message.replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[redacted]@[redacted]@");
}

function writeExecArtifacts(artifactsPath, { stdout, stderr, exitCode, command, cwd }) {
  const target = path.resolve(String(artifactsPath));
  mkdirSync(target, { recursive: true });
  const files = {
    "stdout.txt": String(stdout ?? ""),
    "stderr.txt": String(stderr ?? ""),
    "exit-code.txt": `${exitCode}\n`,
    "manifest.json": JSON.stringify({ command, cwd, exitCode, generatedAt: new Date().toISOString() }) + "\n",
  };
  const temporary = [];
  try {
    for (const [name, content] of Object.entries(files)) {
      const temporaryPath = path.join(target, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
      writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      temporary.push(temporaryPath);
      renameSync(temporaryPath, path.join(target, name));
      temporary.pop();
    }
  } finally {
    for (const temporaryPath of temporary) rmSync(temporaryPath, { force: true });
  }
  return target;
}

async function readRemoteText(sandbox, remotePath) {
  const result = await sandboxExec(sandbox, `[ -f ${shellQuote(remotePath)} ] && cat ${shellQuote(remotePath)}`);
  if (!result) return null;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return null;
  const text = remoteResultText(result);
  if (text === undefined) return null;
  return stripRemoteShellWarnings(text);
}

function parseRemoteInteger(resultText) {
  if (resultText === null) return undefined;
  const normalized = String(resultText).trim();
  if (!normalized) return undefined;
  const value = Number.parseInt(normalized, 10);
  return Number.isInteger(value) ? value : undefined;
}

async function uploadFile(sandbox, localPath, remotePath) {
  if (sandbox.fs?.uploadFiles) return sandbox.fs.uploadFiles([{ source: localPath, destination: remotePath }]);
  const bytes = Buffer.from(readFileSync(localPath));
  if (sandbox.fs?.uploadFile) return sandbox.fs.uploadFile(bytes, remotePath);
  if (sandbox.fs?.upload) return sandbox.fs.upload(bytes, remotePath);
  if (sandbox.uploadFile) return sandbox.uploadFile(bytes, remotePath);
  throw new Error("Sandbox file upload is not supported by this @daytona/sdk version.");
}

async function downloadFile(sandbox, remotePath, localPath) {
  let result;
  if (sandbox.fs?.downloadFile) result = sandbox.fs.downloadFile.length <= 1 ? await sandbox.fs.downloadFile(remotePath) : await sandbox.fs.downloadFile(remotePath, localPath);
  else if (sandbox.fs?.download) result = sandbox.fs.download.length <= 1 ? await sandbox.fs.download(remotePath) : await sandbox.fs.download(remotePath, localPath);
  else if (sandbox.downloadFile) result = sandbox.downloadFile.length <= 1 ? await sandbox.downloadFile(remotePath) : await sandbox.downloadFile(remotePath, localPath);
  else throw new Error("Sandbox file download is not supported by this @daytona/sdk version.");
  if (result !== undefined && result !== null) writeFileSync(localPath, Buffer.isBuffer(result) ? result : Buffer.from(result));
  return result;
}

async function handleUp(options) {
  let effectiveOptions = options;
  let paths = resolveProjectPaths(options);
  if (options.name) {
    const namedBinding = paths.config?.sandboxes?.[options.name];
    if (namedBinding) paths = resolveProjectPaths({ ...options, sandbox: options.name });
    else {
      effectiveOptions = { ...options, ignoreActiveBinding: true, ignoreState: true, ignoreLegacyState: true };
      paths = resolveProjectPaths(effectiveOptions);
    }
  }
  applyProjectEnv(options, paths);
  const existing = effectiveOptions.ignoreState ? null : readProjectState(paths);
  const existingBinding = paths.binding;
  const client = options.client ?? await createClient();
  let sandbox = await getSandbox(client, existingBinding?.sandboxId ?? existing?.sandboxId ?? paths.sandboxId);
  if (sandbox && options.requireManagedPolicy) assertManagedSandbox(sandbox, options.expectedKind ?? "sandbox", options.expectedLifecycle, paths.taskId, paths.binding?.projectIdentity ?? options.expectedProjectIdentity);
  if (!sandbox) {
    const params = buildSandboxCreateParams(options, paths);
    sandbox = await createSandboxWithFallback(client, params, options);
    const provisionalId = sandbox?.id ?? sandbox?.sandboxId ?? sandbox?.instanceId;
    if (provisionalId) {
      try { if (options.writeProvisionalState) writeProvisionalSandboxState(paths, sandbox); }
      catch (error) { error.sandboxId = provisionalId; error.nextActions = recoveryActions(paths.directory, provisionalId, paths.remoteWorkspacePath); throw error; }
      const provisionalName = options.name ?? paths.binding?.name ?? paths.taskId;
      try { upsertBinding(paths.directory, provisionalName, {
        sandboxId: provisionalId,
        snapshot: options.snapshot,
        remoteWorkspace: paths.remoteWorkspacePath,
        projectIdentity: projectIdentity(paths.directory),
        lifecycle: {
          autoStopInterval: options.autoStopInterval ?? options["auto-stop"] ?? 30,
          autoArchiveInterval: options.autoArchiveInterval ?? options["auto-archive"] ?? 10080,
          autoDeleteInterval: options.autoDeleteInterval ?? options["auto-delete"] ?? 60,
        },
        name: options.name,
        createdAt: new Date().toISOString(),
      }, { use: !options.noUse }); }
      catch (error) { error.sandboxId = provisionalId; error.nextActions = recoveryActions(paths.directory, provisionalId, paths.remoteWorkspacePath); throw error; }
    }
  }
  try { sandbox = await ensureSandboxStarted(sandbox); }
  catch (error) {
    const sandboxId = sandbox?.id ?? sandbox?.sandboxId ?? sandbox?.instanceId;
    if (sandboxId && !error.sandboxId) error.sandboxId = sandboxId;
    if (sandboxId) error.nextActions = recoveryActions(paths.directory, sandboxId, paths.remoteWorkspacePath);
    throw error;
  }
  const sandboxId = sandbox.id ?? sandbox.sandboxId ?? sandbox.instanceId;
  const now = new Date().toISOString();
  const lifecycle = {
    autoStopInterval: options.autoStopInterval ?? options["auto-stop"] ?? 30,
    autoArchiveInterval: options.autoArchiveInterval ?? options["auto-archive"] ?? 10080,
    autoDeleteInterval: options.autoDeleteInterval ?? options["auto-delete"] ?? 60,
  };
  const bindingName = options.name ?? existingBinding?.name ?? paths.taskId;
  let binding;
  try { binding = upsertBinding(paths.directory, bindingName, {
    sandboxId,
    remoteWorkspace: paths.remoteWorkspacePath,
    projectIdentity: projectIdentity(paths.directory),
    name: sandbox?.name ?? options.name,
    lifecycle,
    updatedAt: now,
  }, { use: !options.noUse }); }
  catch (error) { error.sandboxId = sandboxId; error.nextActions = recoveryActions(paths.directory, sandboxId, paths.remoteWorkspacePath); throw error; }
  const deleteMessage = lifecycle.autoDeleteInterval === -1
    ? "automatic deletion is disabled"
    : lifecycle.autoDeleteInterval === 0
      ? "stopped sandboxes are permanently deleted immediately"
      : `stopped sandboxes are permanently deleted after ${lifecycle.autoDeleteInterval} minutes`;
  const warning = `Sandbox lifecycle: idle sandboxes stop after ${lifecycle.autoStopInterval} minutes; ${deleteMessage}. Any data not pulled back before deletion will be lost.`;
  const result = { ok: true, sandboxId, name: bindingName, remoteWorkspace: paths.remoteWorkspacePath, lifecycle, warning, binding };
  console.log(JSON.stringify(result, null, 2));
  if (!options.json) console.log(warning);
  return result;
}

async function handleAdopt(options) {
  const paths = resolveProjectPaths({ ...options, allowUnboundSandboxRef: true });
  const existing = readProjectState(paths);
  const remoteWorkspacePath = options["remote-path"] ?? paths.binding?.remoteWorkspace ?? existing?.remoteWorkspacePath;
  if (typeof remoteWorkspacePath !== "string" || !remoteWorkspacePath.trim()) {
    throw new Error("adopt requires a valid --remote-path when no existing remote workspace path is available");
  }
  const sandboxRef = options["sandbox-id"] ?? options["sandbox-name"];
  if (!sandboxRef) throw new Error("adopt requires --sandbox-id ID or --sandbox-name NAME");
  applyProjectEnv(options, paths);
  const client = options.client ?? await createClient();
  const sandbox = await getSandbox(client, sandboxRef, { allowNotFound: false });
  await ensureSandboxStarted(sandbox);
  const { id, name } = sandboxIdentity(sandbox);
  const now = new Date().toISOString();
  const remoteArtifactsPath = remoteWorkspacePath.startsWith("/")
    ? path.posix.join(remoteWorkspacePath, "artifacts", "daytona", paths.taskId)
    : (existing?.remoteArtifactsPath ?? paths.remoteArtifactsPath);
  const bindingName = options.name ?? paths.binding?.name ?? name ?? paths.taskId;
  const binding = upsertBinding(paths.directory, bindingName, {
    sandboxId: id ?? sandboxRef,
    remoteWorkspace: remoteWorkspacePath,
    projectIdentity: projectIdentity(paths.directory),
    name,
    adoptedAt: now,
  }, { use: !options.noUse });
  const result = { ok: true, ...binding, remoteArtifactsPath, adoptedAt: now };
  console.log(JSON.stringify(redactStateForDisplay(result), null, 2));
  return result;
}

async function handleStatus(options) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) {
    const legacy = readProjectState(paths);
    if (legacy) {
      applyProjectEnv(options, paths);
      const client = options.client ?? await createClient();
      const sandbox = await getSandbox(client, legacy.sandboxId, { allowNotFound: false });
      await ensureSandboxStarted(sandbox);
      migrateLegacyStateToConfig(paths, legacy);
      paths.config = readConfig(paths.directory);
      paths.binding = resolveBinding(paths.config ?? { sandboxes: {} }, paths.config?.active);
    }
  }
  if (paths.binding) {
    const display = { ...paths.binding, active: paths.config?.active === paths.binding.name, configFile: path.join(path.dirname(path.join(paths.directory, ".sandbox-ctl", "config.json")), "config.json") };
    if (options.refresh) {
      applyProjectEnv(options, paths);
      const client = options.client ?? await createClient();
      const sandbox = await getSandbox(client, paths.binding.sandboxId);
      display.sandboxKnownToDaytona = Boolean(sandbox);
      if (sandbox) display.sandboxState = sandboxState(sandbox) || null;
    }
    console.log(JSON.stringify(display, null, 2));
    return display;
  }
  const stateSource = readProjectStateWithSource(paths);
  const state = stateSource.state;
  if (!state) { const result = { ok: false, stateFile: paths.stateFile, error: "No Daytona state" }; console.log(JSON.stringify(result, null, 2)); return result; }
  const display = redactStateForDisplay({ ...state, stateFile: paths.stateFile });
  if (options.refresh) {
    applyProjectEnv(options, paths);
    const client = await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    display.sandboxKnownToDaytona = Boolean(sandbox);
    if (sandbox) display.sandboxState = sandboxState(sandbox) || null;
  }
  console.log(JSON.stringify(display, null, 2));
  return display;
}

async function requireSandbox(options, { includeRemoteHome = false } = {}) {
  const paths = resolveProjectPaths(options);
  const legacy = paths.binding ? null : readProjectState(paths);
  const stateBeforeMigration = paths.binding
    ? { sandboxId: paths.binding.sandboxId, remoteWorkspacePath: paths.binding.remoteWorkspace, remoteArtifactsPath: paths.binding.remoteArtifactsPath ?? paths.remoteArtifactsPath, taskId: paths.taskId }
    : legacy;
  if (!stateBeforeMigration?.sandboxId) throw new Error(`No Daytona sandbox state found. Run up first. Expected: ${paths.stateFile}`);
  applyProjectEnv(options, paths);
  const client = options.client ?? await createClient();
  const sandbox = await getSandbox(client, stateBeforeMigration.sandboxId, { allowNotFound: false });
  await ensureSandboxStarted(sandbox);
  if (legacy) {
    migrateLegacyStateToConfig(paths, legacy);
    paths.config = readConfig(paths.directory);
    paths.binding = resolveBinding(paths.config ?? { sandboxes: {} }, paths.config?.active);
  }
  const state = paths.binding
    ? { sandboxId: paths.binding.sandboxId, remoteWorkspacePath: paths.binding.remoteWorkspace, remoteArtifactsPath: paths.binding.remoteArtifactsPath ?? paths.remoteArtifactsPath, taskId: paths.taskId }
    : stateBeforeMigration;
  const result = { paths, state, sandbox };
  if (includeRemoteHome) result.remoteHome = await resolveRemoteHome(sandbox);
  return result;
}

async function handlePush(options) {
  options.path = options.path ?? options.directory ?? process.cwd();
  const mode = options.mode ?? "bundle";
  if (!["bundle", "full", "git"].includes(mode)) throw new Error("push --mode must be bundle, full, or git");
  if (mode !== "git" && (options.committedOnly || options["committed-only"] || options.requireClean || options["require-clean"])) throw new Error("--committed-only/--require-clean are only valid with push --mode git");
  const includeSensitive = Boolean(options.includeSensitive ?? options["include-sensitive"]);
  if (includeSensitive && mode !== "full") throw new Error("--include-sensitive is only valid with --mode full");
  if (mode === "full" && !includeSensitive) throw new Error("--mode full may upload credentials; pass --include-sensitive to confirm");
  const { paths, state, sandbox, remoteHome } = await requireSandbox(options, { includeRemoteHome: true });
  const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath, remoteHome);
  if (mode === "git") {
    const defaultBranch = `sandbox-ctl/${paths.binding?.name ?? paths.taskId}`;
    const branch = validateGitBranch(options.branch ?? state.gitBranch ?? paths.binding?.sync?.branch ?? defaultBranch);
    const safeRemoteWorkspace = assertSafeDestructiveRemoteWorkspace(remoteWorkspace, remoteHome);
    const bindingName = paths.binding?.name ?? paths.taskId;
    const { bundlePath, head, sourceHead, snapshotHead, includedWip, dirty, wipSummary, cleanup } = createGitBundle(options.path, paths.taskId, { ...options, branch, binding: bindingName });
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const remoteBundle = `/tmp/daytona-git-input-${paths.taskId}-${nonce}.bundle`;
      await uploadFile(sandbox, bundlePath, remoteBundle);
      const tempRefName = `refs/sandbox-ctl-sync/push-${paths.taskId}-${nonce}`;
      const markerSource = shellQuote(sourceHead);
      const markerBranch = shellQuote(branch);
      const markerBinding = shellQuote(bindingName);
      const markerBranchLine = shellQuote(`branch=${branch}`);
      const markerBindingLine = shellQuote(`binding=${bindingName}`);
      const markerSourceLine = shellQuote(`source=${sourceHead}`);
      const result = await sandboxExec(sandbox, `${remoteEnsureGitCommand()} && set -eu
target=${shellQuote(safeRemoteWorkspace)}; temp_ref=${shellQuote(tempRefName)}; remote_bundle=${shellQuote(remoteBundle)}
lock_dir=""; lock_held=0
cleanup() {
  if [ "$lock_held" -eq 1 ]; then if ! rmdir "$lock_dir" >/dev/null 2>&1; then echo "Warning: failed to clean remote lock $lock_dir" >&2; fi; fi
  if ! git -C "$target" update-ref -d "$temp_ref" >/dev/null 2>&1; then echo "Warning: failed to clean temporary git ref $temp_ref" >&2; fi
  if ! rm -f "$remote_bundle" >/dev/null 2>&1; then echo "Warning: failed to clean remote bundle $remote_bundle" >&2; fi
}
trap cleanup EXIT
if [ -e "$target" ]; then
  if [ ! -d "$target" ] || ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ ! -d "$target" ] || [ -n "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ]; then echo 'remote workspace is non-git and non-empty; refusing to replace it' >&2; exit 73; fi
    git init "$target" >/dev/null
  fi
else mkdir -p ${shellQuote(path.posix.dirname(safeRemoteWorkspace))} && git init "$target" >/dev/null; fi
git_dir=$(git -C "$target" rev-parse --absolute-git-dir)
lock_dir="$git_dir/sandbox-ctl-sync.lock"
if ! mkdir "$lock_dir" >/dev/null 2>&1; then echo "remote git workspace is busy; retry after lock release ($lock_dir)" >&2; exit 77; fi
lock_held=1
if [ -n "$(git -C "$target" status --porcelain=v2 --untracked-files=all)" ]; then echo 'remote git workspace is dirty; commit or clean it before push' >&2; exit 74; fi
remote_head=$(git -C "$target" rev-parse --verify HEAD 2>/dev/null || true)
current_branch=$(git -C "$target" symbolic-ref --short HEAD 2>/dev/null || true)
if [ -n "$remote_head" ] && [ "$current_branch" != ${markerBranch} ]; then echo 'remote git workspace must have the dedicated branch checked out' >&2; exit 76; fi
bundle_ref=$(git bundle list-heads "$remote_bundle" | awk 'NR==1 {print $2}')
git -C "$target" fetch "$remote_bundle" "\${bundle_ref}:\${temp_ref}" >/dev/null
incoming=$(git -C "$target" rev-parse "$temp_ref")
if [ -n "$remote_head" ]; then
  acceptable=0
  if git -C "$target" merge-base --is-ancestor "$remote_head" ${markerSource}; then acceptable=1; fi
  message=$(git -C "$target" show -s --format=%B "$remote_head")
  if [ "$acceptable" -eq 0 ] && echo "$message" | grep -Fxq 'sandbox-ctl snapshot' && echo "$message" | grep -Fxq ${markerBranchLine} && echo "$message" | grep -Fxq ${markerBindingLine}; then
    marker_source=$(echo "$message" | sed -n 's/^source=//p' | head -n 1)
    if [ -n "$marker_source" ] && git -C "$target" merge-base --is-ancestor "$marker_source" ${markerSource} && git -C "$target" merge-base --is-ancestor "$marker_source" "$remote_head"; then acceptable=1; fi
  fi
  if [ "$acceptable" -eq 0 ]; then echo 'remote git workspace contains a foreign or unrelated commit; refusing push' >&2; exit 75; fi
fi
if [ -z "$remote_head" ]; then git -C "$target" checkout -b ${markerBranch} "$incoming" >/dev/null
else
  tree=$(git -C "$target" rev-parse "$incoming^{tree}")
  old_marker=$(git -C "$target" show -s --format=%B "$remote_head" | grep -Fx 'sandbox-ctl snapshot' || true)
  if [ "$incoming" = ${markerSource} ] && [ -z "$old_marker" ]; then materialized="$incoming"; else
    if [ "$remote_head" != ${markerSource} ]; then materialized=$( { echo 'sandbox-ctl snapshot'; echo ${markerBranchLine}; echo ${markerBindingLine}; echo ${markerSourceLine}; } | GIT_AUTHOR_NAME=sandbox-ctl GIT_AUTHOR_EMAIL=sandbox-ctl@localhost GIT_COMMITTER_NAME=sandbox-ctl GIT_COMMITTER_EMAIL=sandbox-ctl@localhost git -C "$target" commit-tree "$tree" -p "$remote_head" -p ${markerSource}); else materialized=$( { echo 'sandbox-ctl snapshot'; echo ${markerBranchLine}; echo ${markerBindingLine}; echo ${markerSourceLine}; } | GIT_AUTHOR_NAME=sandbox-ctl GIT_AUTHOR_EMAIL=sandbox-ctl@localhost GIT_COMMITTER_NAME=sandbox-ctl GIT_COMMITTER_EMAIL=sandbox-ctl@localhost git -C "$target" commit-tree "$tree" -p "$remote_head"); fi
  fi
  if [ -n "$(git -C "$target" status --porcelain=v2 --untracked-files=all)" ]; then echo 'remote git workspace became dirty before merge' >&2; exit 74; fi
  git -C "$target" merge --ff-only "$materialized" >/dev/null
fi
echo "SANDBOX_SNAPSHOT_HEAD=$(git -C \"$target\" rev-parse HEAD)"`);
      assertRemoteCommandSuccess(result, "git push sync");
      const remoteSnapshotMatch = String(remoteResultText(result) ?? "").match(/SANDBOX_SNAPSHOT_HEAD=([0-9a-f]{40})/);
      if (!remoteSnapshotMatch) throw new Error("git push sync failed: remote did not return a valid snapshot marker");
      const remoteSnapshotHead = remoteSnapshotMatch[1];
      const warnings = dirty ? [includedWip ? "Local repository has uncommitted changes; WIP snapshot included." : "Local repository has uncommitted changes; WIP was excluded (committed HEAD only)."] : [];
      const remoteWarnings = [remoteResultText(result), result?.stderr].filter(Boolean).flatMap((text) => String(text).split(/\r?\n/)).map((line) => line.trim()).filter((line) => /^Warning: failed to clean/i.test(line));
      for (const warning of remoteWarnings) if (!warnings.includes(warning)) warnings.push(warning);
      if (paths.binding) upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false });
      else writeState(paths, { ...state, remoteWorkspacePath: options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath, syncMode: "git", gitBranch: branch, updatedAt: new Date().toISOString() });
      console.log(`Uploaded git bundle to ${safeRemoteWorkspace} on branch ${branch}${warnings.length ? `\nWarning: ${warnings[0]}` : ""}`);
      return { ok: true, mode: "git", remoteWorkspace: safeRemoteWorkspace, branch, sourceHead, snapshotHead: remoteSnapshotHead, includedWip, wipSummary, warnings };
    } finally { cleanup(); }
    return;
  }
  const { bundlePath, cleanup } = createBundle(options.path, paths.taskId, { mode, includeSensitive });
  try {
    const remoteBundle = `/tmp/daytona-input-${paths.taskId}.tar.gz`;
    await uploadFile(sandbox, bundlePath, remoteBundle);
    const result = await sandboxExec(sandbox, `mkdir -p ${shellQuote(remoteWorkspace)} && tar -xzf ${shellQuote(remoteBundle)} -C ${shellQuote(remoteWorkspace)}`);
    assertRemoteCommandSuccess(result, "push extraction");
    console.log(`Uploaded ${mode} archive to ${remoteWorkspace}`);
    return { ok: true, mode, remoteWorkspace };
  } finally { cleanup(); }
}

async function handleExec(options, command) {
  if (!command.length) throw new Error("exec requires a command after --");
  let sandboxInfo;
  try {
    sandboxInfo = await requireSandbox(options, { includeRemoteHome: true });
  } catch (error) {
    return { exitCode: 125, stdout: "", stderr: "", error: redactExecFailure(error) };
  }
  const { paths, state, sandbox, remoteHome } = sandboxInfo;
  const cwd = toRemoteAbsolute(options.cwd ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath, remoteHome);
  const cmd = command.map(shellQuote).join(" ");
  const wrapped = `cd ${shellQuote(cwd)} && ${cmd}`;
  const stdout = [];
  const stderr = [];
  const shouldStream = !options.json && !options.bufferOutput;
  const emit = (kind, chunk) => {
    const text = String(chunk ?? "");
    if (!text) return;
    (kind === "stderr" ? stderr : stdout).push(text);
    if (shouldStream) (kind === "stderr" ? process.stderr : process.stdout).write(text);
  };
  const processApi = sessionProcessApi(sandbox);
  let exitCode;
  let warning;
  if (!processApi) {
    warning = "Output was buffered because streaming is unavailable; client timeout cannot be enforced by this SDK path";
    let result;
    try {
      // Preserve the synchronous SDK contract (command, cwd) for older SDKs.
      result = await sandboxExec(sandbox, cmd, cwd);
    } catch (error) {
      return { exitCode: 125, stdout: stdout.join(""), stderr: stderr.join(""), error: redactExecFailure(error), warning };
    }
    const fallbackStdout = result?.stdout ?? result?.output ?? result?.result ?? result?.data ?? result?.artifacts?.stdout ?? "";
    const fallbackStderr = result?.stderr ?? result?.artifacts?.stderr ?? "";
    emit("stdout", fallbackStdout);
    emit("stderr", fallbackStderr);
    exitCode = remoteExitCode(result?.exitCode) ?? 0;
  } else {
    const sessionId = newExecSessionId();
    let sessionCreated = false;
    let localWaitTimedOut = false;
    try {
      await sessionCall(processApi, "createSession", [sessionId], sessionId);
      sessionCreated = true;
      const commandResult = await sessionCall(processApi, "executeSessionCommand", [sessionId, { command: wrapped, runAsync: true }], { sessionId, command: wrapped, runAsync: true });
      const commandId = commandResult?.cmdId ?? commandResult?.commandId ?? commandResult?.id ?? commandResult;
      if (!commandId) throw new Error("Daytona session command did not return a command id");
      const logsPromise = sessionCall(
        processApi,
        "getSessionCommandLogs",
        [sessionId, commandId, (chunk) => emit("stdout", chunk), (chunk) => emit("stderr", chunk)],
        { sessionId, commandId, onStdout: (chunk) => emit("stdout", chunk), onStderr: (chunk) => emit("stderr", chunk) },
      ).then((logs) => {
        // Some wrappers return a buffered response even when callbacks are accepted.
        if (logs && typeof logs === "object") {
          emit("stdout", logs.stdout ?? "");
          emit("stderr", logs.stderr ?? "");
        }
      });
      const pollPromise = (async () => {
        const interval = Math.max(5, Number(options.pollIntervalMs ?? options.execPollInterval ?? 25));
        const timeout = Math.max(interval, Number(options.timeoutMs ?? options.execTimeout ?? DEFAULT_EXEC_TIMEOUT_MS));
        const deadline = Date.now() + timeout;
        while (Date.now() <= deadline) {
          const status = await sessionCall(processApi, "getSessionCommand", [sessionId, commandId], { sessionId, commandId });
          const code = remoteExitCode(status?.exitCode ?? status?.code);
          if (code !== undefined) return code;
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
        localWaitTimedOut = true;
        throw new Error(`Local wait timed out after ${formatDurationMs(timeout)}; remote command status is unknown and it may still be running`);
      })();
      [exitCode] = await Promise.all([pollPromise, logsPromise]);
    } catch (error) {
      return { exitCode: 125, stdout: stdout.join(""), stderr: stderr.join(""), error: redactExecFailure(error) };
    } finally {
      if (sessionCreated && !localWaitTimedOut) {
        try { await processApi.deleteSession(sessionId); } catch { /* cleanup is best effort */ }
      }
    }
  }
  const result = { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), ...(warning ? { warning } : {}) };
  if (options.artifacts) {
    try { result.artifactPath = writeExecArtifacts(options.artifacts, { ...result, command, cwd }); }
    catch (error) { return { ...result, exitCode: 125, error: redactExecFailure(error) }; }
  }
  if (warning && !options.json && !options.bufferOutput) process.stderr.write(`${warning}\n`);
  return result;
}

/** Preserves the historical (sandbox, remotePath) call signature; the reusable engine in lib/transfer.mjs takes an injected remoteExec so other adapters can bind their own transport. */
async function resolveRemoteTransferPath(sandbox, remotePath) {
  return resolveRemoteTransferPathViaExec((command) => sandboxExec(sandbox, command), remotePath);
}

async function handlePull(options) {
  const mode = options.mode ?? "bundle";
  if (!["bundle", "full", "git"].includes(mode)) throw new Error("pull --mode must be bundle, full, or git");
  if (options.committedOnly || options["committed-only"] || options.requireClean || options["require-clean"]) throw new Error("--committed-only/--require-clean are only valid with push --mode git");
  const { paths, state, sandbox, remoteHome } = await requireSandbox(options, { includeRemoteHome: true });
  const includeSensitive = Boolean(options.includeSensitive ?? options["include-sensitive"]);
  if (includeSensitive && mode !== "full") throw new Error("--include-sensitive is only valid with --mode full");
  if (mode === "full" && !includeSensitive) throw new Error("--mode full may download credentials; pass --include-sensitive to confirm");
  if (mode === "git") {
    const defaultBranch = `sandbox-ctl/${paths.binding?.name ?? paths.taskId}`;
    const branch = validateGitBranch(options.branch ?? state.gitBranch ?? paths.binding?.sync?.branch ?? defaultBranch);
    const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath, remoteHome);
    const remoteBundle = `/tmp/daytona-git-output-${paths.taskId}.bundle`;
    const gitResult = await sandboxExec(sandbox, `${remoteEnsureGitCommand()} && if [ ! -d ${shellQuote(remoteWorkspace)} ] || ! git -C ${shellQuote(remoteWorkspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo 'remote workspace is not a git repository' >&2; exit 73; fi && if [ -n "$(git -C ${shellQuote(remoteWorkspace)} status --porcelain --untracked-files=all)" ]; then echo 'remote git workspace is dirty; commit changes before pull (run sandbox-ctl exec -- git status, then commit explicitly)' >&2; exit 74; fi && git -C ${shellQuote(remoteWorkspace)} bundle create ${shellQuote(remoteBundle)} HEAD`);
    assertRemoteCommandSuccess(gitResult, "git pull sync bundling");
    const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-git-output-"));
    const localBundle = path.join(tempDir, `daytona-git-output-${paths.taskId}.bundle`);
    const warnings = [];
    try {
      await downloadFile(sandbox, remoteBundle, localBundle);
      const received = fetchGitBundleIntoBranch(localBundle, paths.directory, branch);
      const actualBranch = received.branch;
      if (paths.binding) upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false });
      else writeState(paths, { ...state, syncMode: "git", gitBranch: actualBranch, updatedAt: new Date().toISOString() });
      console.log(`Fetched remote git changes into local branch ${actualBranch}`);
      return { ok: true, mode: "git", branch: actualBranch, requestedBranch: branch, diverged: Boolean(received.diverged), warnings };
    } finally {
      try {
        const cleanupResult = await sandboxExec(sandbox, `rm -f ${shellQuote(remoteBundle)}`);
        if (typeof cleanupResult?.exitCode === "number" && cleanupResult.exitCode !== 0) warnings.push(`Failed to clean remote git bundle ${remoteBundle}`);
      } catch (error) { warnings.push(`Failed to clean remote git bundle ${remoteBundle}: ${error?.message ?? error}`); }
      rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }
  const requestedRemotePath = options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath;
  assertSafeRemoteTransferPath(requestedRemotePath);
  const remotePath = toRemoteAbsolute(requestedRemotePath, remoteHome);
  const resolvedRemotePath = await resolveRemoteTransferPath(sandbox, remotePath);
  const output = path.resolve(options.output ?? paths.localArtifactsPath);
  const overwrite = Boolean(options.overwrite);
  prepareTransferOutput(output, path.join(paths.directory, ".sandbox-ctl"), overwrite);
  const remoteBundle = `/tmp/daytona-artifacts-${paths.taskId}.tar.gz`;
  const exclusions = mode === "full" ? [".sandbox-ctl"] : ["--exclude=.env*", "--exclude=.git", "--exclude=.sandbox-ctl", "--exclude=node_modules", "--exclude=.claude", "--exclude=.opencode-state", "--exclude=.daytona", "--exclude=dist", "--exclude=build", "--exclude=*.log", "--exclude=logs"];
  const tarFlags = mode === "full" ? "--exclude=.sandbox-ctl" : exclusions.join(" ");
  const tarResult = await sandboxExec(sandbox, `tar -czf ${shellQuote(remoteBundle)} ${tarFlags} -C ${shellQuote(resolvedRemotePath)} .`);
  assertRemoteCommandSuccess(tarResult, "pull artifact bundling");
  const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-output-"));
  const localBundle = path.join(tempDir, `daytona-output-${paths.taskId}.tar.gz`);
  const staging = path.join(tempDir, "staging");
  mkdirSync(staging);
  try {
    await downloadFile(sandbox, remoteBundle, localBundle);
    const archiveEntries = listTarEntries(localBundle);
    validateTarEntries(archiveEntries);
    assertNoControlArchiveEntries(archiveEntries);
    runTar(["-xzf", localBundle, "-C", staging], process.cwd());
    mergeTransferTree(staging, output, overwrite);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
  console.log(`Downloaded artifacts to ${output}`);
  return { ok: true, mode, output };
}

async function handlePreview(options) {
  if (!options.port) throw new Error("preview requires --port PORT");
  const port = parsePort(options.port);
  const { sandbox } = await requireSandbox(options);
  let preview;
  if (options["expires-in"] && typeof sandbox.getSignedPreviewUrl === "function") preview = await sandbox.getSignedPreviewUrl(port, parsePositiveInteger(options["expires-in"], "expires-in"));
  else if (typeof sandbox.getPreviewLink === "function") preview = await sandbox.getPreviewLink(port);
  else throw new Error("Sandbox preview URL is not supported by this @daytona/sdk version.");
  const url = typeof preview === "string" ? preview : (preview?.url ?? preview?.previewUrl);
  if (!url) throw new Error("Sandbox preview response did not include a URL.");
  const result = { port, url };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function buildSmokeTestOptions(options, testDir, smokeStateDir, taskId) {
  const autoDeleteInterval = options.autoDeleteInterval ?? options["auto-delete"] ?? (options.ephemeral ? 0 : 60);
  const lifecycle = {
    autoStopInterval: options.autoStopInterval ?? options["auto-stop"] ?? 30,
    autoArchiveInterval: options.autoArchiveInterval ?? options["auto-archive"] ?? 10080,
    autoDeleteInterval,
    ephemeral: Boolean(options.ephemeral),
  };
  return {
    ...options,
    directory: testDir,
    "state-directory": smokeStateDir,
    "task-id": taskId,
    class: options.class ?? "small",
    name: options.name ?? `daytona-companion-${taskId}`,
    labels: {
      ...(options.labels ?? {}),
      "sandbox-ctl.managed": "true",
      "sandbox-ctl.kind": "sandbox",
      "sandbox-ctl.adapter": "daytona",
      "sandbox-ctl.policy": "sandbox-v1",
    },
    ...lifecycle,
    requireManagedPolicy: true,
    expectedKind: "sandbox",
    expectedLifecycle: lifecycle,
  };
}

async function handleSmokeTest(options) {
  const parentDir = path.resolve(options.directory ?? tmpdir());
  mkdirSync(parentDir, { recursive: true });
  const testDir = mkdtempSync(path.join(parentDir, "daytona-companion-smoke-"));
  const smokeStateDir = mkdtempSync(path.join(tmpdir(), "daytona-companion-smoke-state-"));
  const taskId = sanitizeTaskId(options["task-id"] ?? `smoke-${Date.now()}`, "task id");
  const inputDir = path.join(testDir, "input");
  const outputDir = path.join(testDir, "pulled");
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(path.join(inputDir, "smoke.txt"), "daytona companion smoke test\n");
  const defaultEnvFile = path.join(DEFAULT_STATE_ROOT, ".env.local");
  const baseOptions = buildSmokeTestOptions(options, testDir, smokeStateDir, taskId);
  if (!baseOptions["env-file"] && existsSync(defaultEnvFile)) baseOptions["env-file"] = defaultEnvFile;
  const summary = { directory: testDir, taskId, checks: [] };
  let workflowError;
  try {
    await handleUp(baseOptions);
    summary.checks.push("up");
    await handleStatus({ ...baseOptions, refresh: true });
    summary.checks.push("status-refresh");
    await handlePush({ ...baseOptions, path: inputDir, mode: "bundle" });
    summary.checks.push("push-bundle");
    await handleExec(baseOptions, ["sh", "-lc", "grep -q 'daytona companion smoke test' smoke.txt && echo REMOTE_SMOKE_OK"]);
    summary.checks.push("exec");
    await handlePull({ ...baseOptions, output: outputDir, mode: "bundle" });
    const stdout = readFileSync(path.join(outputDir, "stdout.txt"), "utf8");
    if (!stdout.includes("REMOTE_SMOKE_OK")) throw new Error("Smoke exec stdout did not contain REMOTE_SMOKE_OK");
    summary.checks.push("pull-bundle");
    if (options["include-preview"]) {
      await handleExec(baseOptions, ["sh", "-lc", "(python3 -m http.server 8765 >/tmp/daytona-companion-smoke-http.log 2>&1 &) && echo PREVIEW_SERVER_STARTED"]);
      await handlePreview({ ...baseOptions, port: "8765" });
      summary.checks.push("preview");
    }
    if (options["include-git"]) {
      runLocal("git", ["init"], testDir, "smoke git init");
      runLocal("git", ["add", "."], testDir, "smoke git add");
      runLocal("git", ["-c", "user.name=Daytona Companion", "-c", "user.email=daytona-companion@example.invalid", "commit", "-m", "initial smoke fixture"], testDir, "smoke git commit");
      const branch = `daytona/${taskId}`;
      await handlePush({ ...baseOptions, path: testDir, mode: "git", branch });
      await handleExec(baseOptions, ["sh", "-lc", "printf 'remote git change\\n' > input/remote-git.txt"]);
      await handlePull({ ...baseOptions, mode: "git", branch });
      runLocal("git", ["rev-parse", "--verify", branch], testDir, "smoke git branch verify");
      const shown = runLocal("git", ["show", `${branch}:input/remote-git.txt`], testDir, "smoke git branch content verify");
      if (!shown.stdout.includes("remote git change")) throw new Error("Git smoke branch did not contain expected remote change");
      summary.checks.push("git-sync");
    }
    const result = { ok: true, ...summary };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    let cleanupError;
    try { await handleDown({ ...baseOptions, expectedLifecycle: undefined }); }
    catch (error) {
      cleanupError = error;
      const state = readProjectState(resolveProjectPaths(baseOptions));
      const sandboxId = state?.sandboxId ?? "unknown";
      const finishCommand = `sandbox-ctl finish --directory ${shellQuote(testDir)} --state-directory ${shellQuote(smokeStateDir)} --task-id ${shellQuote(taskId)} && rmdir ${shellQuote(path.join(smokeStateDir, "projects"))} ${shellQuote(smokeStateDir)}`;
      console.error(`Smoke cleanup failed for sandbox ${sandboxId}: ${error?.message ?? error}. Retained paths: ${shellQuote(testDir)} ${shellQuote(smokeStateDir)}. Next action: ${finishCommand}`);
    }
    if (!cleanupError) {
      rmSync(testDir, { recursive: true, force: true });
      rmSync(smokeStateDir, { recursive: true, force: true });
    } else if (!workflowError) {
      throw cleanupError;
    }
  }
}

async function handleDown(options) {
  const paths = resolveProjectPaths(options);
  if (paths.binding) {
    applyProjectEnv(options, paths);
    const client = options.client ?? await createClient();
    const sandbox = await getSandbox(client, paths.binding.sandboxId);
    if (options.requireManagedPolicy && sandbox) assertManagedSandbox(sandbox, "sandbox", undefined, undefined, paths.binding?.projectIdentity, paths.binding?.legacyIdentity);
    if (sandbox?.delete) await sandbox.delete();
    else if (sandbox) await callFirst(client, ["delete", "deleteSandbox", "remove"], paths.binding.sandboxId);
    removeBinding(paths.directory, paths.binding.name);
    const result = { sandboxId: paths.binding.sandboxId, name: paths.binding.name, stateKept: false };
    console.log("Sandbox deleted; binding removed.");
    return result;
  }
  const stateSource = readProjectStateWithSource(paths);
  const state = stateSource.state;
  if (state?.sandboxId) {
    applyProjectEnv(options, paths);
    const client = options.client ?? await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    if (options.requireManagedPolicy) {
      if (!sandbox) throw new Error(`Managed sandbox not found: ${state.sandboxId}`);
      assertManagedSandbox(sandbox, options.expectedKind ?? "task", undefined, paths.taskId);
    }
    if (sandbox?.delete) await sandbox.delete();
    else await callFirst(client, ["delete", "deleteSandbox", "remove"], state.sandboxId);
  }
  if (!options["keep-state"]) {
    removeStateSource(paths, stateSource.source);
    if (stateSource.source === paths.legacyStateFile) {
      try { rmSync(paths.legacyStateDir, { force: false }); } catch {}
    }
  }
  const result = { sandboxId: state?.sandboxId, stateKept: Boolean(options["keep-state"]) };
  console.log(options["keep-state"] ? "Sandbox deleted; state kept." : "Sandbox deleted; state removed.");
  return result;
}

async function handleList(options = {}) {
  const paths = resolveProjectPaths(options);
  applyProjectEnv(options, paths);
  const client = await createClient();
  const raw = await callFirst(client, ["list", "listSandboxes", "getAll"]);
  const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.data ?? []);
  const sandboxes = items.map((sandbox) => {
    const identity = sandboxIdentity(sandbox);
    return { id: identity.id, name: identity.name, state: sandboxState(sandbox) || undefined };
  });
  const result = { sandboxes };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function sanitizeDiagnostic(value, env = {}) {
  let message = String(value ?? "");
  for (const [key, secret] of Object.entries(env)) if (/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|JWT)/i.test(key) && secret && String(secret).length > 3) message = message.split(String(secret)).join("[redacted]");
  return message.replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[redacted]@[redacted]@");
}

async function runDoctorCheck({ createClient: makeClient, env = process.env } = {}) {
  const apiKeyConfigured = Boolean(env.DAYTONA_API_KEY || env.DAYTONA_API_TOKEN || env.DAYTONA_JWT_TOKEN);
  const apiUrlConfigured = Boolean(env.DAYTONA_API_URL || env.DAYTONA_SERVER_URL);
  try {
    const client = await makeClient();
    if (!client || typeof client.list !== "function") throw new Error("Daytona SDK list API unavailable");
    await client.list();
    return { apiKeyConfigured, apiUrlConfigured, connected: true, category: "ok" };
  } catch (cause) {
    return { apiKeyConfigured, apiUrlConfigured, connected: false, category: "connection_error", error: sanitizeDiagnostic(cause?.message ?? cause, env) };
  }
}

async function handleDoctor(options = {}) {
  try {
    const paths = resolveProjectPaths(options);
    applyProjectEnv(options, paths);
    const result = await runDoctorCheck({ createClient, env: process.env });
    result.ok = result.connected;
    result.checks = { apiKeyConfigured: result.apiKeyConfigured, apiUrlConfigured: result.apiUrlConfigured };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (cause) {
    const result = { ok: false, connected: false, category: "configuration_error", error: sanitizeDiagnostic(cause?.message ?? cause, process.env) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.options.help) { console.log(buildUsage()); return; }
  if (!["push", "pull"].includes(parsed.command) && (parsed.options.committedOnly || parsed.options["committed-only"] || parsed.options.requireClean || parsed.options["require-clean"])) {
    throw new Error("--committed-only/--require-clean are only valid with push --mode git");
  }
  if (parsed.command === "create") return handleUp(parsed.options);
  if (parsed.command === "up") return handleUp(parsed.options);
  if (parsed.command === "adopt" || parsed.command === "import") return handleAdopt(parsed.options);
  if (parsed.command === "status") return handleStatus(parsed.options);
  if (parsed.command === "push") return handlePush(parsed.options);
  if (parsed.command === "exec") return handleExec(parsed.options, parsed.passthrough.length ? parsed.passthrough : parsed.positionals);
  if (parsed.command === "pull") return handlePull(parsed.options);
  if (parsed.command === "preview") return handlePreview(parsed.options);
  if (parsed.command === "smoke-test") return handleSmokeTest(parsed.options);
  if (parsed.command === "delete" || parsed.command === "finish" || parsed.command === "down") return handleDown(parsed.options);
  if (parsed.command === "list") return handleList(parsed.options);
  if (parsed.command === "doctor") return handleDoctor(parsed.options);
  throw new Error(`Unknown command: ${parsed.command}`);
}

function isSameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

const isDirectExecution = isSameRealPath(process.argv[1] ?? "", fileURLToPath(import.meta.url));
if (isDirectExecution) main().then((result) => { if (typeof result?.exitCode === "number") process.exitCode = result.exitCode; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

const runDaytonaManager = main;

export { applyDaytonaEnv, applyProjectEnv, assertManagedSandbox, assertRemoteCommandSuccess, assertSafeDestructiveRemoteWorkspace, assertSafeRemoteTransferPath, buildSandboxCreateParams, buildSmokeTestOptions, buildUsage, collectResources, createBundle, createClient, createGitBundle, createSandboxWithFallback, downloadFile, fetchGitBundleIntoBranch, getSandbox, handleAdopt, handleDown, handleExec, handleList, handleDoctor, handlePreview, handlePull, handlePush, handleSmokeTest, handleStatus, handleUp, hasExplicitResourceFlags, listGitBundle, listTarEntries, loadEnvFile, main, mergeTransferTree, migrateLegacyStateToConfig, parseArgs, parseDurationMs, parsePort, parseRemoteInteger, readProjectState, readProjectStateWithSource, readRemoteText, redactStateForDisplay, remoteEnsureGitCommand, removeStateSource, resolveEnvFile, resolveEnvFiles, resolveProjectPaths, resolveRemoteHome, resolveRemoteTransferPath, runDaytonaManager, runDoctorCheck, sandboxExec, sanitizeTaskId, shellQuote, toRemoteAbsolute, uploadFile, validateGitBranch, validateSandboxClass, validateTarEntries, writeProvisionalSandboxState };
