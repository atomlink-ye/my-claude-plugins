#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const BOOL_FLAGS = ["--help", "--refresh", "--keep-state", "--include-git", "--include-preview"];
const STRING_FLAGS = ["--directory", "--state-directory", "--task-id", "--snapshot", "--name", "--env-file", "--path", "--remote-path", "--mode", "--cwd", "--output", "--sandbox-id", "--sandbox-name", "--class", "--cpu", "--memory", "--disk", "--gpu", "--branch", "--port", "--expires-in"];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const DEFAULT_STATE_ROOT = path.join(homedir(), ".daytona", "claude-code");
const CLASS_RESOURCE_DEFAULTS = {
  small: { cpu: 1, memory: 1, disk: 3, gpu: 0 },
};

function flagName(flag) {
  return flag.replace(/^--/, "");
}

function parseArgs(argv = process.argv.slice(2), config = { booleanFlags: BOOL_FLAGS, stringFlags: STRING_FLAGS }) {
  const options = {};
  const positionals = [];
  const passthrough = [];
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterDashDash) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawFlag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
      if (config.booleanFlags.includes(rawFlag)) {
        options[flagName(rawFlag)] = true;
        continue;
      }
      if (config.stringFlags.includes(rawFlag)) {
        const value = inlineValue ?? argv[++i];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for option: ${rawFlag}`);
        options[flagName(rawFlag)] = value;
        continue;
      }
      throw new Error(`Unknown option: ${rawFlag}`);
    }
    positionals.push(arg);
  }
  return { command: positionals[0], options, positionals: positionals.slice(1), passthrough };
}

function sanitizeTaskId(value, source = "task id") {
  const taskId = String(value ?? "").trim();
  if (!taskId) throw new Error(`Invalid ${source}: must not be empty`);
  if (taskId === "." || taskId === "..") throw new Error(`Invalid ${source}: must not be . or ..`);
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid ${source}: use only letters, numbers, dots, underscores, and hyphens`);
  }
  return taskId;
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

function toRemoteAbsolute(remotePath) {
  const normalized = String(remotePath ?? "").replaceAll("\\", "/");
  if (!normalized) throw new Error("Remote path must not be empty");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) throw new Error(`Unsafe remote path rejected: ${remotePath}`);
  const absolute = normalized.startsWith("/") ? path.posix.normalize(normalized) : path.posix.normalize(path.posix.join("/home/daytona", normalized));
  return absolute;
}

function assertSafeDestructiveRemoteWorkspace(remotePath) {
  const absolute = toRemoteAbsolute(remotePath);
  const allowed = ["/home/daytona/workspace/", "/workspace/"];
  if (!allowed.some((prefix) => absolute.startsWith(prefix)) || ["/", "/home", "/home/daytona", "/home/daytona/workspace", "/workspace", "/tmp"].includes(absolute)) {
    throw new Error(`Refusing destructive operation on unsafe remote path: ${absolute}`);
  }
  return absolute;
}

function validateGitBranch(branch) {
  const value = String(branch ?? "").trim();
  if (!value.startsWith("daytona/")) throw new Error("Git sync branch must be under daytona/");
  const result = spawnSync("git", ["check-ref-format", "--branch", value], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Invalid git branch: ${value}`);
  return value;
}

function remoteEnsureGitCommand() {
  return "if ! command -v git >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then SUDO=''; if [ \"$(id -u)\" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; fi; $SUDO apt-get update && $SUDO apt-get install -y git; elif command -v apk >/dev/null 2>&1; then apk add --no-cache git; else echo 'git not found and no supported package manager available' >&2; exit 127; fi; fi";
}

function resolveProjectPaths(options = {}) {
  const directory = path.resolve(options.directory ?? process.cwd());
  const stateRoot = path.resolve(options["state-directory"] ?? process.env.DAYTONA_STATE_DIR ?? DEFAULT_STATE_ROOT);
  const projectKey = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  const stateDir = path.join(stateRoot, "projects");
  const stateFile = path.join(stateDir, `${projectKey}.json`);
  const legacyStateDir = path.join(directory, ".daytona");
  const legacyStateFile = path.join(legacyStateDir, "state.json");
  const state = readState(stateFile) ?? readState(legacyStateFile);
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
  return { directory, stateRoot, stateDir, stateFile, legacyStateDir, legacyStateFile, projectKey, taskId, remoteWorkspacePath, remoteArtifactsPath, localArtifactsPath };
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

function resolveEnvFile(options = {}, paths = resolveProjectPaths(options)) {
  if (options["env-file"]) return path.resolve(options["env-file"]);
  const projectEnvFile = path.join(paths.directory, ".env.local");
  if (existsSync(projectEnvFile)) return projectEnvFile;
  const globalEnvFile = path.join(paths.stateRoot, ".env.local");
  return existsSync(globalEnvFile) ? globalEnvFile : null;
}

function resolveEnvFiles(options = {}, paths = resolveProjectPaths(options)) {
  if (options["env-file"]) return [path.resolve(options["env-file"])];
  const files = [];
  const globalEnvFile = path.join(paths.stateRoot, ".env.local");
  const projectEnvFile = path.join(paths.directory, ".env.local");
  if (existsSync(globalEnvFile)) files.push(globalEnvFile);
  if (existsSync(projectEnvFile)) files.push(projectEnvFile);
  return files;
}

function applyDaytonaEnv(env = {}) {
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  if (!process.env.DAYTONA_API_KEY && process.env.DAYTONA_API_TOKEN) process.env.DAYTONA_API_KEY = process.env.DAYTONA_API_TOKEN;
}

function applyProjectEnv(options = {}, paths = resolveProjectPaths(options)) {
  const env = {};
  for (const envFile of resolveEnvFiles(options, paths)) Object.assign(env, loadEnvFile(envFile));
  applyDaytonaEnv(env);
}

function redactStateForDisplay(state = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(state ?? {})) redacted[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : value;
  return redacted;
}

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function buildUsage() {
  return [
    "Usage: node scripts/daytona-manager.mjs <command> [options]",
    "",
    "Commands:",
    "  up [--directory DIR] [--state-directory DIR] [--task-id ID] [--snapshot SNAPSHOT] [--name NAME] [--class small|medium|large] [--cpu N --memory GB --disk GB --gpu N] [--env-file FILE]",
    "  adopt [--directory DIR] [--state-directory DIR] [--task-id ID] (--sandbox-id ID | --sandbox-name NAME) [--remote-path PATH] [--env-file FILE]",
    "  status [--directory DIR] [--state-directory DIR] [--refresh] [--env-file FILE]",
    "  push [--directory DIR] [--state-directory DIR] [--task-id ID] --path PATH [--remote-path PATH] [--mode bundle|git] [--branch BRANCH]",
    "  exec [--directory DIR] [--state-directory DIR] [--cwd PATH] -- COMMAND...",
    "  pull [--directory DIR] [--state-directory DIR] [--output DIR] [--remote-path PATH] [--mode bundle|git] [--branch BRANCH]",
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
  return readState(paths.stateFile) ?? readState(paths.legacyStateFile);
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

function runTar(args, cwd) {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`.trim());
  return result;
}

function listTarEntries(bundlePath) {
  const result = runTar(["-tzf", bundlePath], process.cwd());
  return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function validateTarEntries(entries) {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || segments.includes("..")) {
      throw new Error(`Unsafe tar entry rejected: ${entry}`);
    }
  }
  return entries;
}

function createBundle(inputPath, taskId) {
  const abs = path.resolve(inputPath);
  if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);
  const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-input-"));
  const bundlePath = path.join(tempDir, `daytona-input-${taskId}.tar.gz`);
  const exclusions = [".env*", ".git", "node_modules", ".claude", ".opencode-state", ".daytona", "dist", "build", "*.log"];
  const tarArgs = ["-czf", bundlePath];
  if (statSync(abs).isDirectory()) {
    for (const item of exclusions) tarArgs.push("--exclude", item);
    tarArgs.push("-C", abs, ".");
  } else {
    tarArgs.push("-C", path.dirname(abs), path.basename(abs));
  }
  runTar(tarArgs, process.cwd());
  return { bundlePath, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

function runLocal(command, args, cwd, action) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${action} failed: ${result.stderr || result.stdout}`.trim());
  return result;
}

function createGitBundle(repoPath, taskId) {
  const abs = path.resolve(repoPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Git mode requires an existing local repository directory: ${abs}`);
  runLocal("git", ["rev-parse", "--show-toplevel"], abs, "git repository check");
  runLocal("git", ["rev-parse", "--verify", "HEAD"], abs, "git HEAD check");
  const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-git-input-"));
  const bundlePath = path.join(tempDir, `daytona-git-input-${taskId}.bundle`);
  runLocal("git", ["bundle", "create", bundlePath, "HEAD"], abs, "git bundle create");
  return { bundlePath, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

function fetchGitBundleIntoBranch(bundlePath, repoPath, branch) {
  const abs = path.resolve(repoPath);
  const safeBranch = validateGitBranch(branch);
  runLocal("git", ["rev-parse", "--show-toplevel"], abs, "git repository check");
  const current = spawnSync("git", ["branch", "--show-current"], { cwd: abs, encoding: "utf8" });
  if (current.status === 0 && current.stdout.trim() === safeBranch) throw new Error(`Refusing to overwrite currently checked-out branch: ${safeBranch}`);
  runLocal("git", ["fetch", bundlePath, `HEAD:${safeBranch}`, "--force"], abs, "git fetch bundle");
}

async function sandboxExec(sandbox, command, cwd) {
  if (sandbox.process?.executeCommand) return sandbox.process.executeCommand(command, cwd);
  if (sandbox.process?.exec) return sandbox.process.exec(command, cwd ? { cwd } : undefined);
  if (sandbox.exec) return sandbox.exec(command, cwd ? { cwd } : undefined);
  throw new Error("Sandbox command execution is not supported by this @daytona/sdk version.");
}

async function readRemoteText(sandbox, remotePath) {
  const result = await sandboxExec(sandbox, `[ -f ${shellQuote(remotePath)} ] && cat ${shellQuote(remotePath)}`);
  if (!result) return null;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return null;
  if (result.exitCode === undefined && !result.stdout && !result.stderr) return null;
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (stdout !== undefined) return typeof stdout === "string" ? stdout : String(stdout);
  if (stderr !== undefined) return typeof stderr === "string" ? stderr : String(stderr);
  return null;
}

function parseRemoteInteger(resultText) {
  if (resultText === null) return undefined;
  const normalized = String(resultText).trim();
  if (!normalized) return undefined;
  const value = Number.parseInt(normalized, 10);
  return Number.isInteger(value) ? value : undefined;
}

function assertRemoteCommandSuccess(result, action = "remote command") {
  if (typeof result?.exitCode !== "number" || result.exitCode === 0) return result;
  const details = [];
  if (result.stderr) details.push(`stderr: ${String(result.stderr).trim()}`);
  if (result.stdout) details.push(`stdout: ${String(result.stdout).trim()}`);
  if (!details.length) details.push(`result: ${JSON.stringify(result)}`);
  throw new Error(`${action} failed with exit code ${result.exitCode}. ${details.join(" ")}`);
}

async function uploadFile(sandbox, localPath, remotePath) {
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
  const paths = resolveProjectPaths(options);
  applyProjectEnv(options, paths);
  const existing = readProjectState(paths);
  const client = await createClient();
  let sandbox = await getSandbox(client, existing?.sandboxId);
  if (!sandbox) {
    const resources = collectResources(options);
    const params = { name: options.name, snapshot: options.snapshot, resources, labels: { taskId: paths.taskId } };
    for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
    try {
      sandbox = await callFirst(client, ["create", "createSandbox"], params);
    } catch (error) {
      if (!resources || hasExplicitResourceFlags(options)) throw error;
      console.error(`Daytona SDK rejected class-derived resources (${describeDaytonaError(error)}); retrying with provider defaults.`);
      const fallbackParams = { ...params };
      delete fallbackParams.resources;
      sandbox = await callFirst(client, ["create", "createSandbox"], fallbackParams);
    }
  }
  sandbox = await ensureSandboxStarted(sandbox);
  const sandboxId = sandbox.id ?? sandbox.sandboxId ?? sandbox.instanceId;
  const now = new Date().toISOString();
  const state = { projectDirectory: paths.directory, taskId: paths.taskId, sandboxId, sandboxClass: validateSandboxClass(options.class) ?? existing?.sandboxClass, resources: collectResources(options) ?? existing?.resources, remoteWorkspacePath: paths.remoteWorkspacePath, remoteArtifactsPath: paths.remoteArtifactsPath, createdAt: existing?.createdAt ?? now, updatedAt: now };
  for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key];
  writeState(paths, state);
  console.log(JSON.stringify(redactStateForDisplay(state), null, 2));
}

async function handleAdopt(options) {
  const paths = resolveProjectPaths(options);
  applyProjectEnv(options, paths);
  const sandboxRef = options["sandbox-id"] ?? options["sandbox-name"];
  if (!sandboxRef) throw new Error("adopt requires --sandbox-id ID or --sandbox-name NAME");
  const client = await createClient();
  const sandbox = await getSandbox(client, sandboxRef, { allowNotFound: false });
  await ensureSandboxStarted(sandbox);
  const { id, name } = sandboxIdentity(sandbox);
  const now = new Date().toISOString();
  const existing = readProjectState(paths);
  const remoteWorkspacePath = options["remote-path"] ?? existing?.remoteWorkspacePath ?? paths.remoteWorkspacePath;
  const remoteArtifactsPath = remoteWorkspacePath.startsWith("/")
    ? path.posix.join(remoteWorkspacePath, "artifacts", "daytona", paths.taskId)
    : (existing?.remoteArtifactsPath ?? paths.remoteArtifactsPath);
  const state = {
    projectDirectory: paths.directory,
    taskId: paths.taskId,
    sandboxId: id ?? sandboxRef,
    sandboxName: name,
    remoteWorkspacePath,
    remoteArtifactsPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    adoptedAt: now,
  };
  writeState(paths, state);
  console.log(JSON.stringify(redactStateForDisplay(state), null, 2));
}

async function handleStatus(options) {
  const paths = resolveProjectPaths(options);
  const state = readProjectState(paths);
  if (!state) { console.log(`No Daytona state at ${paths.stateFile}`); return; }
  const display = redactStateForDisplay({ ...state, stateFile: paths.stateFile });
  if (options.refresh) {
    applyProjectEnv(options, paths);
    const client = await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    display.sandboxKnownToDaytona = Boolean(sandbox);
    if (sandbox) display.sandboxState = sandboxState(sandbox) || null;
  }
  console.log(JSON.stringify(display, null, 2));
}

async function requireSandbox(options) {
  const paths = resolveProjectPaths(options);
  const state = readProjectState(paths);
  if (!state?.sandboxId) throw new Error(`No Daytona sandbox state found. Run up first. Expected: ${paths.stateFile}`);
  applyProjectEnv(options, paths);
  const client = await createClient();
  const sandbox = await getSandbox(client, state.sandboxId, { allowNotFound: false });
  await ensureSandboxStarted(sandbox);
  return { paths, state, sandbox };
}

async function handlePush(options) {
  if (!options.path) throw new Error("push requires --path PATH");
  const mode = options.mode ?? "bundle";
  if (!["bundle", "git"].includes(mode)) throw new Error("push --mode must be bundle or git");
  const { paths, state, sandbox } = await requireSandbox(options);
  const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath);
  if (mode === "git") {
    const branch = validateGitBranch(options.branch ?? state.gitBranch ?? `daytona/${paths.taskId}`);
    const safeRemoteWorkspace = assertSafeDestructiveRemoteWorkspace(remoteWorkspace);
    const { bundlePath, cleanup } = createGitBundle(options.path, paths.taskId);
    try {
      const remoteBundle = `/tmp/daytona-git-input-${paths.taskId}.bundle`;
      await uploadFile(sandbox, bundlePath, remoteBundle);
      const result = await sandboxExec(sandbox, `${remoteEnsureGitCommand()} && rm -rf ${shellQuote(safeRemoteWorkspace)} && mkdir -p ${shellQuote(path.posix.dirname(safeRemoteWorkspace))} && git clone ${shellQuote(remoteBundle)} ${shellQuote(safeRemoteWorkspace)} && cd ${shellQuote(safeRemoteWorkspace)} && git checkout -B ${shellQuote(branch)} && git config user.name ${shellQuote("Daytona Companion")} && git config user.email ${shellQuote("daytona-companion@example.invalid")}`);
      assertRemoteCommandSuccess(result, "git push sync");
      writeState(paths, { ...state, remoteWorkspacePath: options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath, syncMode: "git", gitBranch: branch, updatedAt: new Date().toISOString() });
      console.log(`Uploaded git bundle to ${safeRemoteWorkspace} on branch ${branch}`);
    } finally { cleanup(); }
    return;
  }
  const { bundlePath, cleanup } = createBundle(options.path, paths.taskId);
  try {
    const remoteBundle = `/tmp/daytona-input-${paths.taskId}.tar.gz`;
    await uploadFile(sandbox, bundlePath, remoteBundle);
    const result = await sandboxExec(sandbox, `mkdir -p ${shellQuote(remoteWorkspace)} && tar -xzf ${shellQuote(remoteBundle)} -C ${shellQuote(remoteWorkspace)}`);
    assertRemoteCommandSuccess(result, "push extraction");
    console.log(`Uploaded bundle to ${remoteWorkspace}`);
  } finally { cleanup(); }
}

async function handleExec(options, command) {
  if (!command.length) throw new Error("exec requires a command after --");
  const { paths, state, sandbox } = await requireSandbox(options);
  const artifacts = toRemoteAbsolute(state.remoteArtifactsPath ?? paths.remoteArtifactsPath);
  const cwd = toRemoteAbsolute(options.cwd ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath);
  const cmd = command.map(shellQuote).join(" ");
  const remoteStdoutPath = `${artifacts}/stdout.txt`;
  const remoteStderrPath = `${artifacts}/stderr.txt`;
  const exitCodePath = `${artifacts}/exit-code.txt`;
  const wrapped = `mkdir -p ${shellQuote(artifacts)}; ( cd ${shellQuote(cwd)} && ${cmd}; ) > ${shellQuote(remoteStdoutPath)} 2> ${shellQuote(remoteStderrPath)}; code=$?; printf '%s\\n' "$code" > ${shellQuote(exitCodePath)}; printf '{"command":%s,"exitCode":%s,"finishedAt":%s}\\n' ${shellQuote(JSON.stringify(cmd))} "$code" ${shellQuote(JSON.stringify(new Date().toISOString()))} > ${shellQuote(`${artifacts}/manifest.json`)}; exit $code`;
  const result = await sandboxExec(sandbox, wrapped);
  if (result?.stdout) process.stdout.write(String(result.stdout));
  if (result?.stderr) process.stderr.write(String(result.stderr));
  const remoteStdout = await readRemoteText(sandbox, remoteStdoutPath);
  if (remoteStdout) process.stdout.write(remoteStdout);
  const remoteStderr = await readRemoteText(sandbox, remoteStderrPath);
  if (remoteStderr) process.stderr.write(remoteStderr);
  const remoteExitCode = parseRemoteInteger(await readRemoteText(sandbox, exitCodePath));
  if (typeof result?.exitCode === "number") process.exitCode = result.exitCode;
  else if (typeof remoteExitCode === "number") process.exitCode = remoteExitCode;
}

async function handlePull(options) {
  const { paths, state, sandbox } = await requireSandbox(options);
  const mode = options.mode ?? "bundle";
  if (!["bundle", "git"].includes(mode)) throw new Error("pull --mode must be bundle or git");
  if (mode === "git") {
    const branch = validateGitBranch(options.branch ?? state.gitBranch ?? `daytona/${paths.taskId}`);
    const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath);
    const remoteBundle = `/tmp/daytona-git-output-${paths.taskId}.bundle`;
    const commitMessage = `sync from Daytona companion ${new Date().toISOString()}`;
    const gitResult = await sandboxExec(sandbox, `${remoteEnsureGitCommand()} && cd ${shellQuote(remoteWorkspace)} && git config user.name ${shellQuote("Daytona Companion")} && git config user.email ${shellQuote("daytona-companion@example.invalid")} && git add -A && (git diff --cached --quiet || git commit -m ${shellQuote(commitMessage)}) && git bundle create ${shellQuote(remoteBundle)} HEAD`);
    assertRemoteCommandSuccess(gitResult, "git pull sync bundling");
    const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-git-output-"));
    const localBundle = path.join(tempDir, `daytona-git-output-${paths.taskId}.bundle`);
    try {
      await downloadFile(sandbox, remoteBundle, localBundle);
      fetchGitBundleIntoBranch(localBundle, paths.directory, branch);
      writeState(paths, { ...state, syncMode: "git", gitBranch: branch, updatedAt: new Date().toISOString() });
      console.log(`Fetched remote git changes into local branch ${branch}`);
    } finally { rmSync(tempDir, { recursive: true, force: true }); }
    return;
  }
  const remotePath = toRemoteAbsolute(options["remote-path"] ?? state.remoteArtifactsPath ?? paths.remoteArtifactsPath);
  const output = path.resolve(options.output ?? paths.localArtifactsPath);
  mkdirSync(output, { recursive: true });
  const remoteBundle = `/tmp/daytona-artifacts-${paths.taskId}.tar.gz`;
  const tarResult = await sandboxExec(sandbox, `tar -czf ${shellQuote(remoteBundle)} -C ${shellQuote(remotePath)} .`);
  assertRemoteCommandSuccess(tarResult, "pull artifact bundling");
  const localBundle = path.join(output, "artifacts.tar.gz");
  await downloadFile(sandbox, remoteBundle, localBundle);
  validateTarEntries(listTarEntries(localBundle));
  runTar(["-xzf", localBundle, "-C", output], process.cwd());
  console.log(`Downloaded artifacts to ${output}`);
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
  console.log(JSON.stringify({ port, url }, null, 2));
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
  const baseOptions = { ...options, directory: testDir, "state-directory": smokeStateDir, "task-id": taskId, class: options.class ?? "small", name: options.name ?? `daytona-companion-${taskId}` };
  if (!baseOptions["env-file"] && existsSync(defaultEnvFile)) baseOptions["env-file"] = defaultEnvFile;
  const summary = { directory: testDir, taskId, checks: [] };
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
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } finally {
    try { await handleDown(baseOptions); } catch (error) { console.error(`Smoke cleanup failed: ${error?.message ?? error}`); }
    rmSync(testDir, { recursive: true, force: true });
    rmSync(smokeStateDir, { recursive: true, force: true });
  }
}

async function handleDown(options) {
  const paths = resolveProjectPaths(options);
  const state = readProjectState(paths);
  if (state?.sandboxId) {
    applyProjectEnv(options, paths);
    const client = await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    if (sandbox?.delete) await sandbox.delete();
    else await callFirst(client, ["delete", "deleteSandbox", "remove"], state.sandboxId);
  }
  if (!options["keep-state"]) {
    rmSync(paths.stateFile, { force: true });
    rmSync(paths.legacyStateDir, { recursive: true, force: true });
  }
  console.log(options["keep-state"] ? "Sandbox deleted; state kept." : "Sandbox deleted; state removed.");
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.options.help) { console.log(buildUsage()); return; }
  if (parsed.command === "up") return handleUp(parsed.options);
  if (parsed.command === "adopt" || parsed.command === "import") return handleAdopt(parsed.options);
  if (parsed.command === "status") return handleStatus(parsed.options);
  if (parsed.command === "push") return handlePush(parsed.options);
  if (parsed.command === "exec") return handleExec(parsed.options, parsed.passthrough.length ? parsed.passthrough : parsed.positionals);
  if (parsed.command === "pull") return handlePull(parsed.options);
  if (parsed.command === "preview") return handlePreview(parsed.options);
  if (parsed.command === "smoke-test") return handleSmokeTest(parsed.options);
  if (parsed.command === "down") return handleDown(parsed.options);
  throw new Error(`Unknown command: ${parsed.command}`);
}

function isSameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

const isDirectExecution = isSameRealPath(process.argv[1] ?? "", fileURLToPath(import.meta.url));
if (isDirectExecution) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

export { applyDaytonaEnv, applyProjectEnv, assertRemoteCommandSuccess, assertSafeDestructiveRemoteWorkspace, buildUsage, collectResources, createBundle, createGitBundle, downloadFile, fetchGitBundleIntoBranch, hasExplicitResourceFlags, listTarEntries, loadEnvFile, parseArgs, parsePort, parseRemoteInteger, readProjectState, readRemoteText, redactStateForDisplay, remoteEnsureGitCommand, resolveEnvFile, resolveEnvFiles, resolveProjectPaths, sandboxExec, sanitizeTaskId, shellQuote, toRemoteAbsolute, uploadFile, validateGitBranch, validateSandboxClass, validateTarEntries };
