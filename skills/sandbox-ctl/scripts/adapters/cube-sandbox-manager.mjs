#!/usr/bin/env node

// Cube Sandbox adapter: mirrors adapters/daytona-manager.mjs's exported handler surface
// (handleUp, handleExec, handleDown, handlePush, handlePull, handlePreview,
// handleList, handleDoctor) against a self-hosted Cube cluster's
// E2B-compatible API via the `e2b` npm SDK, reusing the same adapter-agnostic
// lib/cli-shared.mjs, lib/transfer.mjs, and lib/git-sync.mjs modules Daytona's
// adapter uses.
//
// Key facts about the `e2b` SDK (2.38.2) confirmed by reading the installed
// package's type declarations/source directly (node_modules/e2b/dist/index.d.ts
// and index.js) rather than guessing from docs:
//   - `Sandbox` (default export, also named) exposes everything as *static*
//     methods (`Sandbox.create`, `Sandbox.connect`, `Sandbox.list`,
//     `Sandbox.getInfo`, `Sandbox.kill`, `Sandbox.pause`) plus instance methods on a connected
//     sandbox (`sbx.commands`, `sbx.files`, `sbx.getHost(port)`, `sbx.kill()`).
//     There is no separate client-instance object to construct the way
//     Daytona's `new Daytona(options)` works; `createClient()` below resolves
//     connection env vars and returns the `Sandbox` class itself, used exactly
//     like Daytona's `client` parameter (`client.create(...)`, etc.) so real
//     and fake/test clients share one shape.
//   - `Sandbox.list(opts)` returns a `SandboxPaginator`, NOT an array — callers
//     must `while (paginator.hasNext) { const items = await paginator.nextItems(); }`
//     (confirmed at node_modules/e2b/dist/index.d.ts around the `Sandbox.list`
//     and `Paginator` declarations).
//   - `sbx.commands.run(cmd, { background: false, ... })` (the foreground,
//     streaming exec path `handleExec` needs) *throws* a `CommandExitError`
//     when the remote exit code is non-zero (confirmed in
//     node_modules/e2b/dist/index.js: `CommandHandle.wait()` does
//     `if (result.exitCode !== 0) throw new CommandExitError(result)`, and
//     `commands.run()` without `background` calls `proc.wait()`). It resolves
//     normally only on exit code 0. `CommandExitError` implements the same
//     `{ exitCode, stdout, stderr }` shape as a successful `CommandResult` via
//     getters, so `cubeSandboxExec()` below duck-types on that shape instead of doing
//     an `instanceof CommandExitError` check — this also makes it trivial for
//     unit tests to simulate a non-zero remote exit without needing the real
//     SDK class loaded (see cube-sandbox-manager.test.mjs).
//   - onStdout/onStderr callbacks are guaranteed to have already fired for all
//     produced output by the time `wait()` resolves/rejects (`_wait = this.handleEvents()`
//     is awaited before the exit-code check), so `handleExec` below never
//     double-counts or misses streamed output when it also reads the final
//     CommandExitError's `.stdout`/`.stderr`.
//   - `sbx.files.write(path, data, opts)` / `sbx.files.read(path, { format })`
//     (`format: 'text' | 'bytes' | 'blob' | 'stream'`) and the batch
//     `sbx.files.writeFiles(files, opts)` are confirmed exact camelCase names
//     (JS SDK, not the Python SDK's snake_case). `write()` accepts a Node
//     `Buffer` (it wraps data in `new Blob([data])` internally).
//   - `sbx.files.getInfo(path)` returns `{ type: 'file' | 'dir' | 'symlink', ... }`,
//     used here to auto-detect the single-file transfer fast path for `pull`.
//   - `sbx.getHost(port)` is an *instance* method (matches the plan doc).
//   - Sandbox lifecycle is a single `timeoutMs`; manual pause uses the static
//     `Sandbox.pause` call and resume uses `Sandbox.connect`. The SDK's
//     top-level autoPause/autoResume serialization does not match Cube v0.6's
//     nested lifecycle contract, so idle auto-pause is intentionally not sent.
//     There is no
//     Cube/e2b equivalent of Daytona's separate auto-stop/auto-archive/
//     auto-delete three-timer model; `handleUp` reports this honestly instead
//     of inventing a false mapping.
//   - `SandboxOpts`/`SandboxInfo` both carry a free-form `metadata` map, which
//     is a clean equivalent of Daytona's sandbox `labels` for the
//     destructive-action ownership check `handleDown` needs (see
//     `assertManagedSandboxInfo`) — confirmed in the type declarations
//     (`SandboxOpts.metadata`, `SandboxInfo.metadata`).
//   - Errors use a `.name` string (e.g. `"SandboxNotFoundError"`,
//     `"FileNotFoundError"`) rather than always being easy to `instanceof`
//     across a dynamically-imported module boundary, so `isNotFoundError`
//     below checks `.name` instead of importing the error classes.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";

import { getActiveBinding, readConfig, removeBinding, resolveBinding, upsertBinding } from "../project-config.mjs";
import { parseArgs as parseArgsGeneric, sanitizeTaskId, shellQuote } from "../lib/cli-shared.mjs";
import {
  assertNoControlArchiveEntries,
  assertRemoteCommandSuccess,
  assertSafeRemoteTransferPath,
  createBundle,
  listTarEntries,
  mergeTransferTree,
  prepareTransferOutput,
  resolveRemoteTransferPath as resolveRemoteTransferPathViaExec,
  runTar,
  validateTarEntries,
} from "../lib/transfer.mjs";
import { createGitBundle, fetchGitBundleIntoBranch, remoteEnsureGitCommand, validateGitBranch } from "../lib/git-sync.mjs";
import { classifyFailure, createDaemonClient, FAILURE_KINDS, readExecutionRecord, readExecutions, runtimePaths, startDaemon } from "../lib/cube-sandbox-daemon.mjs";
import { configStatus, configuredPath, materializeCubeSandboxEnv, readCubeSandboxUserConfig, resolveCubeSandboxValues, writeCubeSandboxUserConfig } from "../lib/cube-sandbox-user-config.mjs";

const BOOL_FLAGS = ["--help", "--include-sensitive", "--overwrite", "--committed-only", "--require-clean", "--keep-state", "--no-use"];
const STRING_FLAGS = ["--directory", "--task-id", "--template", "--name", "--path", "--remote-path", "--mode", "--cwd", "--output", "--artifacts", "--sandbox", "--sandbox-id", "--sandbox-name", "--branch", "--port", "--timeout", "--workspace-owner", "--node"];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const SENSITIVE_BASENAME_RE = /^(\.env(?:\..*)?|\.git|node_modules|dist|build|\.claude|\.opencode-state|\.daytona|\.sandbox-ctl|logs|.+\.log)$/;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
// Cube/e2b has no auto-stop/auto-archive/auto-delete distinction; this is the
// single idle timeout `up` requests by default (30 minutes, chosen to match
// Daytona's default autoStopInterval so an unattended dev sandbox behaves
// similarly), overridable with `--timeout`.
const DEFAULT_SANDBOX_TIMEOUT_MS = 1_800_000;

/** Cube's flag surface is fixed (BOOL_FLAGS/STRING_FLAGS); the parsing engine itself lives in lib/cli-shared.mjs so it's shared with Daytona's adapter. */
function parseArgs(argv = process.argv.slice(2), config = { booleanFlags: BOOL_FLAGS, stringFlags: STRING_FLAGS }) {
  const parsed = parseArgsGeneric(argv, config);
  const isUp = parsed.command === "up" || parsed.command === "create" || ((parsed.command === "task" || parsed.command === "project") && parsed.positionals[0] === "up");
  if (parsed.options.node !== undefined && !isUp) {
    throw new Error("--node is only supported with up");
  }
  return parsed;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port: expected integer 1-65535");
  return port;
}

function projectIdentity(directory) {
  directory = directory ?? process.cwd();
  let resolved;
  try { resolved = realpathSync(directory); } catch { resolved = path.resolve(directory); }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

function normalizeRemoteHome(remoteHome) {
  if (remoteHome === undefined || remoteHome === null || remoteHome === "") return undefined;
  const normalized = path.posix.normalize(String(remoteHome).replaceAll("\\", "/"));
  if (!normalized.startsWith("/") || normalized === "/" || normalized.split("/").includes("..") || /\s/.test(normalized)) {
    throw new Error(`Invalid remote home: ${remoteHome}`);
  }
  return normalized;
}

function normalizeWorkspaceOwner(value, source = "workspace owner") {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Error(`Invalid ${source}: expected non-root positive UID:GID (for example 1000:1000)`);
  const uid = Number(match[1]);
  const gid = Number(match[2]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
    throw new Error(`Invalid ${source}: UID and GID must be non-root positive integers`);
  }
  return { uid, gid };
}

function workspaceOwnerKey(owner) {
  return owner ? `${owner.uid}:${owner.gid}` : "";
}

function resolveWorkspaceOwner(options = {}, binding) {
  const requested = options.workspaceOwner ?? options["workspace-owner"];
  const requestedOwner = requested === undefined ? undefined : normalizeWorkspaceOwner(requested, "--workspace-owner");
  const bindingOwner = binding?.workspaceOwner === undefined ? undefined : normalizeWorkspaceOwner(`${binding.workspaceOwner?.uid}:${binding.workspaceOwner?.gid}`, "binding workspaceOwner");
  if (requestedOwner && bindingOwner && workspaceOwnerKey(requestedOwner) !== workspaceOwnerKey(bindingOwner)) {
    throw new Error(`Workspace owner ${workspaceOwnerKey(requestedOwner)} differs from the bound workspace owner ${workspaceOwnerKey(bindingOwner)}; migrate the workspace explicitly before changing ownership`);
  }
  return requestedOwner ?? bindingOwner;
}

function workspaceProvisionCommand(remoteWorkspace, owner) {
  const target = shellQuote(remoteWorkspace);
  if (!owner) return `mkdir -p ${target}`;
  const ownerValue = `${owner.uid}:${owner.gid}`;
  return `set -eu
target=${target}; expected_owner=${shellQuote(ownerValue)}
if [ -e "$target" ] && [ ! -d "$target" ]; then echo "workspace path exists but is not a directory: $target" >&2; exit 78; fi
if [ -d "$target" ] && [ -n "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  actual_owner=$(stat -c '%u:%g' "$target" 2>/dev/null || stat -f '%u:%g' "$target" 2>/dev/null || true)
  if [ "$actual_owner" != "$expected_owner" ]; then
    echo "workspace ownership mismatch: non-empty workspace is owned by $actual_owner, expected $expected_owner; migrate ownership explicitly before retrying" >&2
    exit 78
  fi
  mismatch=$(find "$target" -mindepth 1 \\( ! -uid ${owner.uid} -o ! -gid ${owner.gid} \\) -print -quit 2>/dev/null || true)
  if [ -n "$mismatch" ]; then
    actual=$(stat -c '%u:%g' "$mismatch" 2>/dev/null || stat -f '%u:%g' "$mismatch" 2>/dev/null || true)
    echo "workspace ownership mismatch: entry $mismatch is owned by $actual, expected $expected_owner; migrate ownership explicitly before retrying" >&2
    exit 78
  fi
fi
install -d -o ${owner.uid} -g ${owner.gid} -- "$target"`;
}

function toRemoteAbsolute(remotePath, remoteHome = process.env.CUBE_REMOTE_HOME) {
  const normalized = String(remotePath ?? "").replaceAll("\\", "/");
  if (!normalized) throw new Error("Remote path must not be empty");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) throw new Error(`Unsafe remote path rejected: ${remotePath}`);
  const base = normalizeRemoteHome(remoteHome);
  if (!normalized.startsWith("/") && !base) {
    throw new Error("Relative remote paths require a remote home; resolve sandbox $HOME or set CUBE_REMOTE_HOME");
  }
  const absolute = normalized.startsWith("/") ? path.posix.normalize(normalized) : path.posix.normalize(path.posix.join(base, normalized));
  return absolute;
}

function assertSafeDestructiveRemoteWorkspace(remotePath, remoteHome = process.env.CUBE_REMOTE_HOME) {
  const absolute = toRemoteAbsolute(remotePath, remoteHome);
  const home = normalizeRemoteHome(remoteHome);
  const allowed = home ? [`${home}/workspace/`, "/workspace/"] : ["/workspace/"];
  const blocked = ["/", "/home", home, home ? `${home}/workspace` : undefined, "/workspace", "/tmp"].filter(Boolean);
  if (!allowed.some((prefix) => absolute.startsWith(prefix)) || blocked.includes(absolute)) {
    throw new Error(`Refusing destructive operation on unsafe remote path: ${absolute}`);
  }
  return absolute;
}

/**
 * Resolve the project directory, task id, remote workspace default, and any
 * existing sandbox binding for this project — the Cube Sandbox analog of
 * Daytona's resolveProjectPaths(). Unlike Daytona, Cube Sandbox has no legacy
 * pre-config on-disk state format to migrate; the binding in
 * .sandbox-ctl/config.json (via project-config.mjs) is the only source of
 * truth from day one, which keeps this considerably simpler.
 */
function resolveProjectPaths(options = {}) {
  const directory = path.resolve(options.directory ?? process.cwd());
  const config = readConfig(directory);
  const explicitSandbox = options.sandbox ?? options["sandbox-name"] ?? options["sandbox-id"];
  const binding = explicitSandbox
    ? resolveBinding(config ?? { sandboxes: {} }, explicitSandbox)
    : options.ignoreActiveBinding ? null : getActiveBinding(directory);
  if (explicitSandbox && !binding) throw new Error(`Sandbox binding not found: ${explicitSandbox}`);
  const rawTaskId = options["task-id"];
  const defaultTaskId = path.basename(directory).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const taskId = sanitizeTaskId(rawTaskId ?? defaultTaskId, rawTaskId === undefined ? "default task id" : "task id");
  const remoteWorkspacePath = `workspace/${taskId}`;
  const localArtifactsPath = path.join(directory, "artifacts", "cube-sandbox", taskId);
  const resolvedRemoteWorkspace = options.remoteWorkspace ?? options["remote-path"] ?? binding?.remoteWorkspace ?? remoteWorkspacePath;
  const resolvedSandboxId = options.sandboxId ?? options["sandbox-id"] ?? binding?.sandboxId;
  return { directory, taskId, remoteWorkspacePath: resolvedRemoteWorkspace, localArtifactsPath, config, binding, sandboxId: resolvedSandboxId };
}

async function loadCubeSandboxSdk() {
  try {
    return await import("e2b");
  } catch (directImportError) {
    throw new Error(`e2b SDK is required for this command. Install it with: pnpm add e2b (or install plugin dependencies). Original error: ${directImportError?.message ?? directImportError}`);
  }
}

/** Resolve Cube's connection env vars.  The SDK accepts these values as
 * per-call options; keeping them explicit is important because an E2B_* value
 * in the parent process must never win over a configured CUBE_* value. */
function resolveCubeSandboxEnv(env = process.env) {
  const resolved = resolveCubeSandboxValues({ env });
  const apiKey = resolved.api.key;
  const apiUrl = resolved.api.url;
  const proxy = resolved.network.proxyUrl;
  materializeCubeSandboxEnv(env);
  // Keep the upstream SDK's process-wide defaults useful for callers outside
  // this adapter, but never rely on them: explicit options below always win.
  if (apiKey && !env.E2B_API_KEY) env.E2B_API_KEY = apiKey;
  if (apiUrl && !env.E2B_API_URL) env.E2B_API_URL = apiUrl;
  return { apiKey, apiUrl, proxy, ...resolved.network };
}

function addConnectionOptions(method, args, connection) {
  if (!connection || !Object.keys(connection).length) return args;
  const result = [...args];
  const merge = (index) => { result[index] = { ...(result[index] ?? {}), ...connection }; };
  if (method === "create") merge(typeof result[0] === "string" ? 1 : 0);
  else if (method === "connect" || method === "getInfo" || method === "kill" || method === "pause" || method === "list") merge(method === "list" ? 0 : 1);
  return result;
}

const REQUIRED_SANDBOX_STATIC_METHODS = ["create", "connect", "list", "getInfo", "kill"];

function hasSandboxLifecycleMethods(value) {
  return typeof value === "function"
    && REQUIRED_SANDBOX_STATIC_METHODS.every((method) => typeof value[method] === "function");
}

/**
 * Dynamic ESM imports of the CommonJS-compatible e2b package have appeared in
 * three shapes: a named Sandbox export, a default namespace containing
 * Sandbox, and a default Sandbox class. Resolve those shapes to the actual
 * static lifecycle owner and reject namespace objects or partial exports
 * before any handler can make a real request.
 */
function resolveSandboxLifecycleClass(sdk) {
  const candidates = [sdk?.Sandbox, sdk?.default?.Sandbox, sdk?.default, typeof sdk === "function" ? sdk : undefined];
  const Sandbox = candidates.find((candidate) => hasSandboxLifecycleMethods(candidate));
  if (Sandbox) return Sandbox;
  throw new Error(`Could not resolve the e2b Sandbox lifecycle facade: expected a callable Sandbox class with static ${REQUIRED_SANDBOX_STATIC_METHODS.join(", ")} methods (supported shapes: sdk.Sandbox, sdk.default.Sandbox, or sdk.default).`);
}

function wrapCubeSandboxClient(sdk, connection) {
  const Sandbox = resolveSandboxLifecycleClass(sdk);
  if (!connection || !Object.values(connection).some((value) => value !== undefined && value !== "")) return Sandbox;
  const methods = new Set(["create", "connect", "list", "getInfo", "kill", "pause"]);
  return new Proxy(Sandbox, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (!methods.has(property) || typeof value !== "function") return value;
    return (...args) => value.apply(target, addConnectionOptions(property, args, connection));
  } });
}

/**
 * Cube Sandbox analog of Daytona's createClient(): there is no instantiated
 * client object in the `e2b` SDK (everything is a static method on the
 * `Sandbox` class), so this resolves/validates connection env vars and
 * returns the `Sandbox` class itself as the "client" — every handler below
 * calls `client.create(...)`, `client.connect(...)`, `client.list(...)`,
 * `client.getInfo(...)`, `client.kill(...)` exactly as it would on the real
 * SDK export, which also makes it trivial to inject a fake object with the
 * same shape via `options.client` in tests.
 */
async function createClient(options = {}) {
  const connection = resolveCubeSandboxEnv(options.env ?? process.env);
  const { apiKey, apiUrl } = connection;
  let proxy = connection.proxy;
  // In direct-dial mode the loopback proxy belongs to the shared daemon. CLI
  // lifecycle calls (up/status/down/list/doctor) must use the same proxy as
  // daemon-routed exec instead of attempting to resolve sandbox DNS locally.
  if (!proxy && connection.proxyNodeIp) {
    const daemon = await startDaemon();
    proxy = daemon.proxyUrl ?? daemon.state?.proxyUrl;
    if (!proxy) throw new Error("Cube Sandbox direct-dial proxy is unavailable; daemon status did not provide a loopback proxy endpoint");
  }
  if (!apiKey) throw new Error("Cube Sandbox API key is required. Set CUBE_API_KEY or E2B_API_KEY.");
  if (!apiUrl) throw new Error("Cube Sandbox API URL is required. Set CUBE_API_URL or E2B_API_URL to a network-reachable operator endpoint; do not rely on the SDK's public e2b.dev default.");
  const sdk = options.sdk ?? await loadCubeSandboxSdk();
  // Pass every connection setting explicitly to every static SDK lifecycle
  // call.  This prevents unrelated E2B_* environment values from silently
  // selecting a different account or cluster when CUBE_* is configured.
  return wrapCubeSandboxClient(sdk, { apiKey, apiUrl, proxy });
}

function buildUserConfigFromEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const existing = readCubeSandboxUserConfig(options);
  const resolved = resolveCubeSandboxValues({ env, config: existing });
  if (!resolved.api.url || !resolved.api.key) throw new Error("Cube Sandbox config set requires API URL and API key (set CUBE_API_URL/CUBE_API_KEY or E2B_API_URL/E2B_API_KEY)");
  const config = { schemaVersion: 1, adapters: { "cube-sandbox": { api: {}, network: {} } } };
  for (const [field, value] of Object.entries(resolved.api)) if (value !== undefined && value !== "") config.adapters["cube-sandbox"].api[field] = String(value);
  for (const [field, value] of Object.entries(resolved.network)) if (value !== undefined && value !== "") config.adapters["cube-sandbox"].network[field] = String(value);
  if (Object.keys(resolved.scheduler ?? {}).length) config.adapters["cube-sandbox"].scheduler = {
    ...(resolved.scheduler.nodes ? { nodes: resolved.scheduler.nodes } : {}),
    ...(resolved.scheduler.sshHost ? { sshHost: String(resolved.scheduler.sshHost) } : {}),
    ...(resolved.scheduler.cliPath ? { cliPath: String(resolved.scheduler.cliPath) } : {}),
  };
  return config;
}

async function handleConfig(options = {}) {
  const command = options.configCommand ?? options.command ?? "status";
  const configOptions = { env: options.env ?? process.env, platform: options.platform, home: options.home };
  const configPathValue = configuredPath(configOptions.env, configOptions.platform ?? process.platform, configOptions.home);
  if (command === "path") return { ok: true, path: configPathValue };
  if (command === "status") return { ok: true, ...configStatus(configOptions) };
  if (command !== "set") throw new Error("Usage: sandbox-ctl --adapter cube-sandbox config set|status|path");
  const config = buildUserConfigFromEnvironment(options);
  const filePath = writeCubeSandboxUserConfig(config, configOptions);
  const fields = [];
  for (const [group, values] of Object.entries(config.adapters["cube-sandbox"])) for (const field of Object.keys(values)) fields.push(`${group}.${field}`);
  return { ok: true, path: filePath, configuredFields: fields };
}

function isNotFoundError(error) {
  const name = String(error?.name ?? "");
  if (["SandboxNotFoundError", "NotFoundError", "FileNotFoundError"].includes(name)) return true;
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("not found") || message.includes("404");
}

/**
 * Run a command on a connected sandbox and normalize the result to
 * `{ exitCode, stdout, stderr }` regardless of whether it succeeded or
 * failed. Foreground `commands.run(cmd, { background: false })` *throws* a
 * `CommandExitError` on non-zero exit (see the file header note); rather than
 * `instanceof CommandExitError` (which would require the real SDK module to
 * be loaded even in tests using a fake sandbox), this duck-types on the
 * `{ exitCode: number, stdout: string, stderr: string }` shape, which the
 * real error implements via getters and which fakes can trivially reproduce.
 */
async function cubeSandboxExec(sandbox, cmd, opts = {}) {
  try {
    const result = await sandbox.commands.run(cmd, { background: false, ...opts });
    return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    if (typeof error?.exitCode === "number") {
      return { exitCode: error.exitCode, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw error;
  }
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
    const result = await cubeSandboxExec(sandbox, `sh -lc ${shellQuote(command)}`);
    if (typeof result?.exitCode === "number" && result.exitCode !== 0) continue;
    const output = result?.stdout ?? "";
    for (const line of String(output).split(/\r?\n/)) {
      const remoteHome = line.trim();
      if (!remoteHome || /warning:|cannot change locale/i.test(remoteHome)) continue;
      try {
        const normalized = normalizeRemoteHome(remoteHome);
        if (normalized) return normalized;
      } catch { continue; }
    }
  }
  throw new Error("Could not determine sandbox remote home from environment or passwd database");
}

async function uploadFile(sandbox, localPath, remotePath) {
  const bytes = readFileSync(localPath);
  await sandbox.files.write(remotePath, bytes);
}

async function downloadFile(sandbox, remotePath, localPath) {
  const bytes = await sandbox.files.read(remotePath, { format: "bytes" });
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  writeFileSync(localPath, buffer);
  return buffer;
}

function createCubeSandboxBundle(...args) {
  const previous = process.env.COPYFILE_DISABLE;
  process.env.COPYFILE_DISABLE = "1";
  try { return createBundle(...args); }
  finally {
    if (previous === undefined) delete process.env.COPYFILE_DISABLE;
    else process.env.COPYFILE_DISABLE = previous;
  }
}

function assertSafeLocalTransferFile(absPath) {
  const resolvedAbs = (() => { try { return realpathSync(absPath); } catch { return absPath; } })();
  if ([absPath, resolvedAbs].some((candidate) => candidate.split(path.sep).includes(".sandbox-ctl"))) {
    throw new Error(`Refusing to upload .sandbox-ctl control directory: ${absPath}`);
  }
}

function assertNotSensitiveSingleFile(basename, mode, includeSensitive) {
  if (mode === "full" && includeSensitive) return;
  if (SENSITIVE_BASENAME_RE.test(basename)) throw new Error(`Refusing sensitive path in single-file transfer: ${basename}; use --mode full --include-sensitive`);
}

function resolveSingleFileRemoteTarget(remotePathOption, remoteWorkspace, basename, remoteHome) {
  if (!remotePathOption) return toRemoteAbsolute(path.posix.join(remoteWorkspace, basename), remoteHome);
  const normalized = String(remotePathOption).replaceAll("\\", "/");
  const target = normalized.endsWith("/") ? path.posix.join(normalized, basename) : normalized;
  return toRemoteAbsolute(target, remoteHome);
}

function assertSafeLocalOutputDir(outputDir, controlRoot) {
  const relativeControl = path.relative(path.resolve(controlRoot), path.resolve(outputDir));
  if (relativeControl === "" || (!relativeControl.startsWith("..") && !path.isAbsolute(relativeControl))) {
    throw new Error(`Refusing to extract into .sandbox-ctl control directory: ${outputDir}`);
  }
}

/**
 * Cube Sandbox equivalent of Daytona's assertManagedSandbox()/labels check.
 * Cube Sandbox has no built-in label metadata system like Daytona, but `Sandbox.create`
 * accepts an arbitrary `metadata` map that's returned back on `getInfo`/`list`
 * (confirmed in the type declarations) — a clean equivalent, not a gap. `up`
 * tags every sandbox it creates with `sandbox-ctl.managed`/`.project`, and
 * `down` can verify it via this check before killing (opt-in through
 * `options.requireManagedPolicy`, matching Daytona's own default-off pattern
 * for handleDown — the primary safety net for both adapters is that a binding
 * only ever addresses the exact sandboxId recorded for it).
 */
function assertManagedSandboxInfo(info, expectedProjectIdentity) {
  const metadata = info?.metadata ?? {};
  if (String(metadata["sandbox-ctl.managed"]) !== "true") throw new Error("Refusing operation on unmanaged sandbox");
  if (expectedProjectIdentity !== undefined && String(metadata["sandbox-ctl.project"]) !== String(expectedProjectIdentity)) {
    throw new Error("Sandbox project identity mismatch");
  }
  return info;
}

async function requireSandbox(options) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) throw new Error("No Cube Sandbox binding found for this directory. Run up first.");
  const client = options.client ?? await createClient();
  let sandbox;
  const sandboxTimeoutMs = paths.binding.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  try {
    sandbox = await client.connect(paths.binding.sandboxId, { timeoutMs: sandboxTimeoutMs });
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube Sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  const remoteHome = paths.binding.remoteHome ?? await resolveRemoteHome(sandbox);
  if (!paths.binding.remoteHome) {
    try { upsertBinding(paths.directory, paths.binding.name, { remoteHome, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube-sandbox" }); } catch { /* command can continue; retry persistence next invocation */ }
  }
  return { paths, sandbox, remoteHome };
}

/** Evict a cached daemon connection so the next exec cannot reuse a paused
 * SDK object. The daemon is started on demand for lifecycle commands, while
 * injected clients remain a deterministic test/rescue seam. */
async function invalidateDaemonConnection(sandboxId, options = {}) {
  if (!sandboxId) throw new Error("sandboxId is required to invalidate the daemon connection");
  let daemon = options.daemonClient
    ? (typeof options.daemonClient === "function" ? await options.daemonClient() : options.daemonClient)
    : null;
  const daemonOptions = options.daemon ?? {};
  if (!daemon) {
    await (options.startDaemon ?? startDaemon)(daemonOptions);
    daemon = createDaemonClient(daemonOptions);
  }
  if (typeof daemon.invalidate !== "function") throw new Error("Cube Sandbox daemon client does not support connection invalidation");
  const result = await daemon.invalidate(sandboxId);
  const nonzeroExit = Number.isInteger(result?.exitCode) && result.exitCode !== 0;
  if (nonzeroExit || result?.error || result?.ok === false) {
    const detail = result?.error ? `: ${result.error}` : nonzeroExit ? ` (exit code ${result.exitCode})` : "";
    throw new Error(`Could not invalidate the local Cube Sandbox daemon connection for ${sandboxId}${detail}; inspect daemon status and probe another binding before optionally restarting the local daemon`);
  }
  return result;
}

function remoteExitCode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
}

function sanitizeDiagnosticUrls(value) {
  return String(value ?? "").replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    let trailing = "";
    let candidate = raw;
    while (/[),.;!?]$/.test(candidate)) {
      trailing = candidate.slice(-1) + trailing;
      candidate = candidate.slice(0, -1);
    }
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return `${url.toString()}${trailing}`;
    } catch {
      return candidate.replace(/:[^/@\s]+@/g, "@").replace(/[?#].*$/, "") + trailing;
    }
  });
}

function redactExecFailure(error) {
  let message = sanitizeDiagnosticUrls(error?.message ?? error);
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_KEY_RE.test(key) && value && value.length > 3) message = message.split(value).join("[redacted]");
  }
  return sanitizeDiagnosticUrls(message);
}

function daemonUnavailableDiagnostic(error) {
  const detail = redactExecFailure(error);
  return `Local Cube Sandbox daemon/proxy is unavailable${detail ? `: ${detail}` : ""}. Inspect daemon status and probe another binding before considering a restart.`;
}

function assertWorkspaceOwnership(result, action = "workspace ownership validation") {
  try {
    return assertRemoteCommandSuccess(result, action);
  } catch (error) {
    if (result?.exitCode === 78) {
      const details = [result.stderr, result.stdout].filter(Boolean).map((value) => String(value).trim()).filter(Boolean).join(" ");
      const mismatch = new Error(`Workspace ownership mismatch: ${details || error.message}`);
      mismatch.exitCode = 78;
      throw mismatch;
    }
    throw error;
  }
}

function assertSchedulerToken(value, source, { pathValue = false } = {}) {
  const text = String(value ?? "");
  if (!text || text.length > 255 || text.startsWith("-") || /[\s\u0000-\u001f\u007f\\'\"`;$(){}|<>]/.test(text) || (!pathValue && text.includes("/"))) {
    throw new Error(`Invalid Cube scheduler ${source}`);
  }
  return text;
}

function assertSshHost(value) {
  const text = assertSchedulerToken(value, "sshHost");
  const validDestination = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(text)
    || net.isIP(text) > 0
    || /^[A-Za-z0-9][A-Za-z0-9._-]*@[0-9A-Fa-f:]+$/.test(text);
  if (!validDestination) throw new Error("Invalid Cube scheduler sshHost");
  return text;
}

function assertTemplateId(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error("Invalid Cube scheduler template");
  return text;
}

function assertCliPath(value) {
  const text = String(value ?? "");
  if (!/^\/[A-Za-z0-9._/-]+$/.test(text) || text.split("/").includes("..")) throw new Error("Invalid Cube scheduler cliPath");
  return text;
}

function resolveSchedulerNode(node, scheduler = {}) {
  const requested = assertSchedulerToken(node, "node");
  if (net.isIP(requested)) return requested;
  const mapped = scheduler?.nodes?.[requested];
  if (mapped === undefined) throw new Error(`Unknown Cube scheduler node alias: ${requested}; configure scheduler.nodes or pass a bare IP`);
  const resolved = assertSchedulerToken(mapped, `node mapping ${requested}`);
  if (net.isIP(resolved) === 0) throw new Error(`Cube scheduler node mapping ${requested} must resolve to an IP address`);
  return resolved;
}

function resolveSchedulerConfig({ env = process.env } = {}) {
  const resolved = resolveCubeSandboxValues({ env });
  const scheduler = resolved.scheduler ?? {};
  if (!scheduler.sshHost) throw new Error("Cube scheduler config is missing scheduler.sshHost (set CUBE_SCHEDULER_SSH_HOST or use config set)");
  if (!scheduler.cliPath) throw new Error("Cube scheduler config is missing scheduler.cliPath (set CUBE_SCHEDULER_CLI_PATH or use config set)");
  assertSshHost(scheduler.sshHost);
  assertCliPath(scheduler.cliPath);
  return scheduler;
}

const NODE_CREATE_SCRIPT = `set -eu
tmpdir="$(mktemp -d "\${TMPDIR:-/tmp}/sandbox-ctl.XXXXXX")"
trap 'rm -rf -- "$tmpdir"' EXIT HUP INT TERM
render="$tmpdir/render.json"
request="$tmpdir/request.json"
if ! "$2" template render --template-id "$1" --json >"$render" 2>"$tmpdir/render.stderr"; then
  echo "template render failed" >&2
  exit 78
fi
if ! jq -e '.api_request != null and (.api_request | type == "object")' "$render" >/dev/null 2>&1; then
  echo "template render did not return a valid api_request" >&2
  exit 78
fi
jq -ce '.api_request' "$render" >"$request"
"$2" multirun --norm --printall --fail_exit --async_retry_max 0 --hostid "$3" "$request" 2>&1
`;

function runSpawnedSsh({ sshHost, template, cliPath, node, spawnImpl = nodeSpawn } = {}) {
  assertSshHost(sshHost);
  assertTemplateId(template);
  assertCliPath(cliPath);
  if (net.isIP(String(node)) === 0) throw new Error("Cube scheduler node must be an IP address");
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl("ssh", ["--", sshHost, "sh", "-s", "--", template, cliPath, node], { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ exitCode: code ?? 255, signal, stdout: stdout.join(""), stderr: stderr.join("") }));
    child.stdin?.end(NODE_CREATE_SCRIPT);
  });
}

function parseNodeCreateResult({ exitCode, stdout = "", stderr = "" } = {}) {
  const codes = [...String(stdout).matchAll(/\bcode:(-?\d+)\b/g)].map((match) => Number(match[1]));
  const successCounts = [...String(stdout).matchAll(/\btotalRunSuccCnt:(\d+)\b/g)].map((match) => Number(match[1]));
  const errorCounts = [...String(stdout).matchAll(/\btotalRunErr:(\d+)\b/g)].map((match) => Number(match[1]));
  const sandboxIds = [...String(stdout).matchAll(/\bsandBoxId:([A-Fa-f0-9]{16,64})(?=,|\s|$)/g)].map((match) => match[1]).filter(Boolean);
  const valid = exitCode === 0 && codes.length === 1 && codes[0] === 200 && successCounts.length === 1 && successCounts[0] === 1 && errorCounts.length === 1 && errorCounts[0] === 0 && sandboxIds.length === 1;
  if (!valid) {
    const details = `sshExit=${exitCode}; code=${codes.join(",") || "missing"}; totalRunSuccCnt=${successCounts.join(",") || "missing"}; totalRunErr=${errorCounts.join(",") || "missing"}; sandBoxId=${sandboxIds.length ? "present" : "missing"}`;
    throw new Error(`Cube node sandbox creation failed strict success gates (${details})`);
  }
  return { sandboxId: sandboxIds[0], stdout, stderr };
}

async function createCubeSandboxOnNode({ template, node, env = process.env, spawnImpl = nodeSpawn } = {}) {
  if (!template) throw new Error("Cube Sandbox up --node requires --template TEMPLATE_ID");
  const scheduler = resolveSchedulerConfig({ env });
  const resolvedNode = resolveSchedulerNode(node, scheduler);
  const result = await runSpawnedSsh({ sshHost: scheduler.sshHost, template, cliPath: scheduler.cliPath, node: resolvedNode, spawnImpl });
  return parseNodeCreateResult(result);
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

async function handleUp(options) {
  let paths = resolveProjectPaths(options);
  if (options.name && !paths.config?.sandboxes?.[options.name]) paths = resolveProjectPaths({ ...options, ignoreActiveBinding: true });
  else if (options.name) paths = resolveProjectPaths({ ...options, sandbox: options.name });
  const existingBinding = paths.binding;
  const template = options.template ?? options.snapshot ?? existingBinding?.template;
  if (options.node !== undefined && existingBinding?.sandboxId) {
    throw new Error("Cube Sandbox up --node only creates a new binding; an existing sandbox binding is already selected");
  }
  if (!existingBinding?.sandboxId && !template) throw new Error("Cube Sandbox up requires --template TEMPLATE_ID for a new sandbox");
  const nodeMode = options.node !== undefined;
  let client = options.client;
  const timeoutMs = options.timeoutMs ?? existingBinding?.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const workspaceOwner = resolveWorkspaceOwner(options, existingBinding);
  let sandbox = null;
  if (nodeMode) {
    const createdOnNode = await createCubeSandboxOnNode({ template, node: options.node, env: options.env ?? process.env, spawnImpl: options.spawnImpl ?? nodeSpawn });
    client = client ?? await createClient();
    try { sandbox = await client.connect(createdOnNode.sandboxId, { timeoutMs }); }
    catch (error) {
      try { await client.kill?.(createdOnNode.sandboxId); } catch { /* preserve the connection error; no binding was written */ }
      throw error;
    }
  } else {
    client = client ?? await createClient();
    if (existingBinding?.sandboxId) {
      try { sandbox = await client.connect(existingBinding.sandboxId, { timeoutMs }); }
      catch (error) { if (!isNotFoundError(error)) throw error; sandbox = null; }
    }
  }
  let created = nodeMode;
  if (!sandbox) {
    if (!template) throw new Error("Cube Sandbox up requires --template TEMPLATE_ID when the bound sandbox no longer exists");
    const metadata = {
      "sandbox-ctl.managed": "true",
      "sandbox-ctl.kind": "sandbox",
      "sandbox-ctl.adapter": "cube-sandbox",
      "sandbox-ctl.policy": "sandbox-v1",
      "sandbox-ctl.project": projectIdentity(paths.directory),
      taskId: paths.taskId,
    };
    sandbox = await client.create({ template, timeoutMs, metadata });
    created = true;
  }
  const sandboxId = sandbox.sandboxId ?? sandbox.id;
  if (!sandboxId) throw new Error("Cube Sandbox create did not return a sandbox ID");
  const bindingName = options.name ?? existingBinding?.name ?? paths.taskId;
  let remoteHome;
  let binding;
  try {
    remoteHome = existingBinding?.remoteHome ?? await resolveRemoteHome(sandbox);
    const remoteWorkspace = toRemoteAbsolute(paths.remoteWorkspacePath, remoteHome);
    const workspaceResult = await cubeSandboxExec(sandbox, workspaceProvisionCommand(remoteWorkspace, workspaceOwner));
    assertWorkspaceOwnership(workspaceResult, "workspace initialization");
    binding = upsertBinding(paths.directory, bindingName, {
      sandboxId,
      remoteHome,
      remoteWorkspace: paths.remoteWorkspacePath,
      timeoutMs,
      ...(workspaceOwner ? { workspaceOwner } : {}),
      template,
      projectIdentity: projectIdentity(paths.directory),
      name: options.name,
      createdAt: existingBinding?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { use: !options.noUse, adapter: "cube-sandbox" });
  } catch (error) {
    if (created && sandboxId) {
      try { await client.kill(sandboxId); }
      catch (cleanupError) {
        error.sandboxId = sandboxId;
        const recoveryName = `recovery-${String(sandboxId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
        try {
          upsertBinding(paths.directory, recoveryName, { sandboxId, remoteHome, remoteWorkspace: paths.remoteWorkspacePath, timeoutMs, ...(workspaceOwner ? { workspaceOwner } : {}), projectIdentity: projectIdentity(paths.directory), updatedAt: new Date().toISOString() }, { use: false, adapter: "cube-sandbox" });
          error.nextActions = [`sandbox-ctl down --adapter cube-sandbox --directory ${shellQuote(paths.directory)} --sandbox ${shellQuote(recoveryName)}`];
        } catch {
          error.nextActions = [
            `sandbox-ctl adopt --adapter cube-sandbox --directory ${shellQuote(paths.directory)} --sandbox-id ${shellQuote(sandboxId)} --name ${shellQuote(recoveryName)} --remote-path ${shellQuote(paths.remoteWorkspacePath)}`,
            `sandbox-ctl down --adapter cube-sandbox --directory ${shellQuote(paths.directory)} --sandbox ${shellQuote(recoveryName)}`,
          ];
        }
        error.message = `${error.message}; cleanup failed for sandbox ${sandboxId}: ${cleanupError?.message ?? cleanupError}`;
      }
    }
    throw error;
  }
  const warning = `Sandbox lifecycle: Cube Sandbox enforces a single idle timeout (~${Math.round(timeoutMs / 60000)} minutes here) after which the sandbox is killed by default; there is no Cube Sandbox/e2b equivalent of Daytona's separate auto-stop/auto-archive/auto-delete timers. Any data not pulled back before the timeout is lost.`;
  const result = { ok: true, sandboxId, name: bindingName, remoteWorkspace: paths.remoteWorkspacePath, template, timeoutMs, warning, binding };
  console.log(JSON.stringify(result, null, 2));
  if (!options.json) console.log(warning);
  return result;
}

async function handleStatus(options = {}) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) throw new Error("No Cube Sandbox binding found for this directory.");
  const client = options.client ?? await createClient();
  if (typeof client.getInfo !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose getInfo; status will not connect to determine state");
  let info;
  try {
    info = await client.getInfo(paths.binding.sandboxId);
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: "not-found", binding: paths.binding };
    throw error;
  }
  const safeInfo = {
    state: info?.state,
    template: info?.templateId ?? info?.template,
    name: info?.name,
    createdAt: info?.createdAt,
    updatedAt: info?.updatedAt,
    endAt: info?.endAt,
    metadata: info?.metadata && typeof info.metadata === "object" ? Object.fromEntries(Object.entries(info.metadata).filter(([key]) => !SECRET_KEY_RE.test(key))) : undefined,
  };
  const result = { ok: true, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: info?.state ?? "unknown", ...safeInfo, binding: paths.binding };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function handleAdopt(options = {}) {
  const sandboxId = options.sandboxId ?? options["sandbox-id"];
  if (!sandboxId) throw new Error("adopt requires --sandbox-id");
  const remoteWorkspace = options.remoteWorkspace ?? options["remote-path"];
  if (!remoteWorkspace || typeof remoteWorkspace !== "string") throw new Error("adopt requires a valid --remote-path");
  const directory = path.resolve(options.directory ?? process.cwd());
  const name = options.name ?? `adopted-${String(sandboxId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  const client = options.client ?? await createClient();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  let info;
  if (typeof client.getInfo === "function") info = await client.getInfo(sandboxId);
  const sandbox = await client.connect(sandboxId, { timeoutMs });
  if (options.requireManagedPolicy && info) assertManagedSandboxInfo(info, projectIdentity(directory));
  if (typeof sandbox?.setTimeout !== "function") {
    throw new Error("Cube Sandbox adopt cannot set lifecycle timeout: sandbox.setTimeout is unavailable");
  }
  await sandbox.setTimeout(timeoutMs);
  const remoteHome = options.remoteHome ?? await resolveRemoteHome(sandbox);
  const binding = upsertBinding(directory, name, { sandboxId, remoteHome, remoteWorkspace, timeoutMs, projectIdentity: projectIdentity(directory), adoptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { use: !options.noUse, adapter: "cube-sandbox" });
  const result = { ok: true, sandboxId, name, remoteHome, remoteWorkspace, timeoutMs, binding };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function handleExec(options, command) {
  if (!command.length) throw new Error("exec requires a command after --");
  // Cube commands use the local per-user daemon by default. A supplied client
  // remains an explicit test/rescue seam, and SANDBOX_CTL_DISABLE_DAEMON=1
  // retains the old direct SDK path for diagnosis.
  if (!options.client && process.env.SANDBOX_CTL_DISABLE_DAEMON !== "1") {
    const daemonResult = await handleExecViaDaemon(options, command);
    if (daemonResult) return daemonResult;
  }
  if (options.timeoutMs !== undefined) {
    const error = "Direct Cube Sandbox diagnostic mode cannot provide durable local timeout recovery; omit --timeout or enable the daemon-backed exec path";
    return { exitCode: 125, stdout: "", stderr: "", error, failure: { kind: FAILURE_KINDS.PROXY_TRANSPORT, message: error } };
  }
  let sandboxInfo;
  try {
    sandboxInfo = await requireSandbox(options);
  } catch (error) {
    return { exitCode: 125, stdout: "", stderr: "", error: redactExecFailure(error), failure: classifyFailure(error, FAILURE_KINDS.SANDBOX_CONNECT) };
  }
  const { paths, sandbox, remoteHome } = sandboxInfo;
  const cwd = toRemoteAbsolute(options.cwd ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath, remoteHome);
  const cmd = command.map(shellQuote).join(" ");
  const stdout = [];
  const stderr = [];
  const shouldStream = !options.json && !options.bufferOutput;
  const emit = (kind, chunk) => {
    const text = String(chunk ?? "");
    if (!text) return;
    (kind === "stderr" ? stderr : stdout).push(text);
    if (shouldStream) (kind === "stderr" ? process.stderr : process.stdout).write(text);
  };
  const runOptions = {
    background: false,
    cwd,
    onStdout: (chunk) => emit("stdout", chunk),
    onStderr: (chunk) => emit("stderr", chunk),
  };
  if (options.remoteTimeoutMs !== undefined) runOptions.timeoutMs = options.remoteTimeoutMs;
  const commandPromise = Promise.resolve().then(() => sandbox.commands.run(cmd, runOptions));
  const outcome = await commandPromise.then((result) => ({ kind: "result", result }), (error) => ({ kind: "error", error }));
  let exitCode;
  if (outcome.kind === "error") {
    const { error } = outcome;
    // Duck-typed CommandExitError (see cubeSandboxExec's header note): stdout/stderr
    // were already streamed via onStdout/onStderr by the time wait() rejects,
    // so we only need the exit code here — re-appending error.stdout/stderr
    // would double the buffered text.
    if (typeof error?.exitCode === "number" && typeof error?.stdout === "string" && typeof error?.stderr === "string") {
      exitCode = remoteExitCode(error.exitCode) ?? 125;
    } else {
      return { exitCode: 125, stdout: stdout.join(""), stderr: stderr.join(""), error: redactExecFailure(error), failure: classifyFailure(error, FAILURE_KINDS.PROXY_TRANSPORT) };
    }
  } else {
    exitCode = remoteExitCode(outcome.result?.exitCode) ?? 0;
  }
  const result = { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), ...(exitCode !== 0 ? { failure: { kind: FAILURE_KINDS.REMOTE_COMMAND, remoteExitCode: exitCode } } : {}) };
  if (options.artifacts) {
    try { result.artifactPath = writeExecArtifacts(options.artifacts, { ...result, command, cwd }); }
    catch (error) { return { ...result, exitCode: 125, error: redactExecFailure(error) }; }
  }
  return result;
}

async function handleExecViaDaemon(options, command) {
  let paths;
  const stdout = [];
  const stderr = [];
  const executionId = randomUUID();
  try {
    paths = resolveProjectPaths(options);
    if (!paths.binding?.sandboxId) return null;
    const daemon = options.daemonClient
      ? (typeof options.daemonClient === "function" ? await options.daemonClient() : options.daemonClient)
      : createDaemonClient(options.daemon ?? {});
    if (!options.daemonClient) await (options.startDaemon ?? startDaemon)(options.daemon ?? {});
    const cwd = options.cwd ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath;
    const result = await daemon.exec({
      executionId,
      sandboxId: paths.binding.sandboxId,
      command: command.map(shellQuote).join(" "),
      cwd,
      remoteHome: paths.binding.remoteHome,
      sandboxTimeoutMs: paths.binding.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      localWaitTimeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      ...(options.remoteTimeoutMs !== undefined ? { remoteTimeoutMs: options.remoteTimeoutMs } : {}),
      onStdout: (chunk) => { const text = String(chunk ?? ""); stdout.push(text); if (!options.json && !options.bufferOutput) process.stdout.write(text); },
      onStderr: (chunk) => { const text = String(chunk ?? ""); stderr.push(text); if (!options.json && !options.bufferOutput) process.stderr.write(text); },
    });
    const normalized = { executionId: result.executionId ?? executionId, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 125, stdout: result.stdout ?? stdout.join(""), stderr: result.stderr ?? stderr.join(""), ...(result.remoteHome ? { remoteHome: result.remoteHome } : {}), ...(result.failure ? { failure: result.failure } : {}) };
    if (result.remoteHome && !paths.binding.remoteHome) {
      try { upsertBinding(paths.directory, paths.binding.name, { remoteHome: result.remoteHome, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube-sandbox" }); } catch { /* preserve command result; next direct run can retry */ }
    }
    if (result.error) {
      const diagnostic = daemonUnavailableDiagnostic(result.error);
      normalized.exitCode = 125;
      normalized.error = diagnostic;
      normalized.failure = result.failure ?? classifyFailure(result, FAILURE_KINDS.PROXY_TRANSPORT);
      normalized.stderr = normalized.stderr ? `${normalized.stderr}${normalized.stderr.endsWith("\n") ? "" : "\n"}${diagnostic}\n` : `${diagnostic}\n`;
    }
    if (options.artifacts && !normalized.error) {
      try { normalized.artifactPath = writeExecArtifacts(options.artifacts, { ...normalized, command, cwd }); }
      catch (error) { return { ...normalized, exitCode: 125, error: redactExecFailure(error) }; }
    }
    return normalized;
  } catch (error) {
    const diagnostic = daemonUnavailableDiagnostic(error);
    const priorStderr = stderr.join("");
    const classified = error.failure ?? classifyFailure(error, FAILURE_KINDS.PROXY_TRANSPORT);
    return { executionId: error.executionId ?? executionId, exitCode: 125, stdout: stdout.join(""), stderr: `${priorStderr}${priorStderr && !priorStderr.endsWith("\n") ? "\n" : ""}${diagnostic}\n`, error: diagnostic, failure: classified, ...(classified.kind === FAILURE_KINDS.LOCAL_TIMEOUT_REMOTE_UNKNOWN ? { remoteStatus: "unknown" } : {}) };
  }
}

async function handleExecRecord(options = {}) {
  const executionId = String(options.executionId ?? options["execution-id"] ?? "");
  if (!executionId) throw new Error("exec status/result requires an execution ID");
  const daemon = options.daemonClient
    ? (typeof options.daemonClient === "function" ? await options.daemonClient() : options.daemonClient)
    : createDaemonClient(options.daemon ?? {});
  const operation = options.execCommand === "status" ? "execStatus" : "execResult";
  if (typeof daemon[operation] === "function") {
    try {
      const result = await daemon[operation](executionId);
      if (result?.status !== "not-found") return result;
    } catch { /* read the durable local record below when the daemon is stopped */ }
  }
  const paths = runtimePaths(options.daemon ?? {});
  const local = readExecutionRecord(paths.executionsDir, executionId) ?? readExecutions(paths.executionsPath)[executionId];
  if (local) return { ok: true, ...local };
  return { ok: false, executionId, status: "not-found", failure: { kind: FAILURE_KINDS.PROXY_TRANSPORT, message: "Execution record was not found" } };
}

async function handlePush(options) {
  options.path = options.path ?? options.directory ?? process.cwd();
  const mode = options.mode ?? "bundle";
  if (!["bundle", "full", "git"].includes(mode)) throw new Error("push --mode must be bundle, full, or git");
  if (mode !== "git" && (options.committedOnly || options["committed-only"] || options.requireClean || options["require-clean"])) throw new Error("--committed-only/--require-clean are only valid with push --mode git");
  const includeSensitive = Boolean(options.includeSensitive ?? options["include-sensitive"]);
  if (includeSensitive && mode !== "full") throw new Error("--include-sensitive is only valid with --mode full");
  if (mode === "full" && !includeSensitive) throw new Error("--mode full may upload credentials; pass --include-sensitive to confirm");
  const ownerBinding = resolveProjectPaths(options);
  const requestedWorkspaceOwner = resolveWorkspaceOwner(options, ownerBinding.binding);
  if (mode === "git" && requestedWorkspaceOwner) {
    throw new Error(`Git push is not supported with workspace owner ${requestedWorkspaceOwner.uid}:${requestedWorkspaceOwner.gid}; use push --mode bundle or push --mode full`);
  }
  const { paths, sandbox, remoteHome } = await requireSandbox(options);
  const workspaceOwner = resolveWorkspaceOwner(options, paths.binding);
  const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath, remoteHome);

  if (mode === "git") {
    const defaultBranch = `sandbox-ctl/${paths.binding.name ?? paths.taskId}`;
    const branch = validateGitBranch(options.branch ?? paths.binding.sync?.branch ?? defaultBranch);
    const safeRemoteWorkspace = assertSafeDestructiveRemoteWorkspace(remoteWorkspace, remoteHome);
    const bindingName = paths.binding.name ?? paths.taskId;
    const { bundlePath, sourceHead, includedWip, dirty, wipSummary, cleanup } = createGitBundle(options.path, paths.taskId, { ...options, branch, binding: bindingName });
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const remoteBundle = `/tmp/cube-sandbox-git-input-${paths.taskId}-${nonce}.bundle`;
      await uploadFile(sandbox, bundlePath, remoteBundle);
      const tempRefName = `refs/sandbox-ctl-sync/push-${paths.taskId}-${nonce}`;
      const markerSource = shellQuote(sourceHead);
      const markerBranch = shellQuote(branch);
      const markerBranchLine = shellQuote(`branch=${branch}`);
      const markerBindingLine = shellQuote(`binding=${bindingName}`);
      const markerSourceLine = shellQuote(`source=${sourceHead}`);
      const result = await cubeSandboxExec(sandbox, `${remoteEnsureGitCommand()} && set -eu
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
      const remoteSnapshotMatch = String(result.stdout ?? "").match(/SANDBOX_SNAPSHOT_HEAD=([0-9a-f]{40})/);
      if (!remoteSnapshotMatch) throw new Error("git push sync failed: remote did not return a valid snapshot marker");
      const remoteSnapshotHead = remoteSnapshotMatch[1];
      const warnings = dirty ? [includedWip ? "Local repository has uncommitted changes; WIP snapshot included." : "Local repository has uncommitted changes; WIP was excluded (committed HEAD only)."] : [];
      const remoteWarnings = [result.stdout, result.stderr].filter(Boolean).flatMap((text) => String(text).split(/\r?\n/)).map((line) => line.trim()).filter((line) => /^Warning: failed to clean/i.test(line));
      for (const warning of remoteWarnings) if (!warnings.includes(warning)) warnings.push(warning);
      upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube-sandbox" });
      console.log(`Uploaded git bundle to ${safeRemoteWorkspace} on branch ${branch}${warnings.length ? `\nWarning: ${warnings[0]}` : ""}`);
      return { ok: true, mode: "git", remoteWorkspace: safeRemoteWorkspace, branch, sourceHead, snapshotHead: remoteSnapshotHead, includedWip, wipSummary, warnings };
    } finally { cleanup(); }
  }

  const localAbs = path.resolve(options.path);
  if (!existsSync(localAbs)) throw new Error(`Path not found: ${localAbs}`);
  assertSafeLocalTransferFile(localAbs);
  const workspaceResult = await cubeSandboxExec(sandbox, workspaceProvisionCommand(remoteWorkspace, workspaceOwner));
  assertWorkspaceOwnership(workspaceResult);

  // Single-file fast path (new relative to Daytona): auto-detected when the
  // local path is not a directory, using sbx.files.write directly with no tar
  // step at all.
  if (!statSync(localAbs).isDirectory()) {
    assertNotSensitiveSingleFile(path.basename(localAbs), mode, includeSensitive);
    const requestedRemotePath = options["remote-path"];
    const explicitRemoteTarget = requestedRemotePath === paths.binding.remoteWorkspace ? undefined : requestedRemotePath;
    const remoteTarget = resolveSingleFileRemoteTarget(explicitRemoteTarget, remoteWorkspace, path.basename(localAbs), remoteHome);
    await uploadFile(sandbox, localAbs, remoteTarget);
    if (workspaceOwner) {
      const ownerResult = await cubeSandboxExec(sandbox, `chown ${workspaceOwner.uid}:${workspaceOwner.gid} -- ${shellQuote(remoteTarget)}`);
      assertRemoteCommandSuccess(ownerResult, "single-file ownership update");
    }
    console.log(`Uploaded file to ${remoteTarget}`);
    return { ok: true, mode: "file", remoteWorkspace: remoteTarget };
  }

  const { bundlePath, cleanup } = createCubeSandboxBundle(options.path, paths.taskId, { mode, includeSensitive, archiveOwner: workspaceOwner });
  try {
    const remoteBundle = `/tmp/cube-sandbox-input-${paths.taskId}.tar.gz`;
    await uploadFile(sandbox, bundlePath, remoteBundle);
    const tarOwnerFlags = workspaceOwner ? "--same-owner --numeric-owner " : "";
    const result = await cubeSandboxExec(sandbox, `tar ${tarOwnerFlags}--no-overwrite-dir -xzf ${shellQuote(remoteBundle)} -C ${shellQuote(remoteWorkspace)}`);
    assertRemoteCommandSuccess(result, "push extraction");
    console.log(`Uploaded ${mode} archive to ${remoteWorkspace}`);
    return { ok: true, mode, remoteWorkspace };
  } finally { cleanup(); }
}

async function handlePull(options) {
  const mode = options.mode ?? "bundle";
  if (!["bundle", "full", "git"].includes(mode)) throw new Error("pull --mode must be bundle, full, or git");
  if (options.committedOnly || options["committed-only"] || options.requireClean || options["require-clean"]) throw new Error("--committed-only/--require-clean are only valid with push --mode git");
  const includeSensitive = Boolean(options.includeSensitive ?? options["include-sensitive"]);
  if (includeSensitive && mode !== "full") throw new Error("--include-sensitive is only valid with --mode full");
  if (mode === "full" && !includeSensitive) throw new Error("--mode full may download credentials; pass --include-sensitive to confirm");
  const { paths, sandbox, remoteHome } = await requireSandbox(options);

  if (mode === "git") {
    const defaultBranch = `sandbox-ctl/${paths.binding.name ?? paths.taskId}`;
    const branch = validateGitBranch(options.branch ?? paths.binding.sync?.branch ?? defaultBranch);
    const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath, remoteHome);
    const remoteBundle = `/tmp/cube-sandbox-git-output-${paths.taskId}.bundle`;
    const gitResult = await cubeSandboxExec(sandbox, `${remoteEnsureGitCommand()} && if [ ! -d ${shellQuote(remoteWorkspace)} ] || ! git -C ${shellQuote(remoteWorkspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo 'remote workspace is not a git repository' >&2; exit 73; fi && if [ -n "$(git -C ${shellQuote(remoteWorkspace)} status --porcelain --untracked-files=all)" ]; then echo 'remote git workspace is dirty; commit changes before pull (run sandbox-ctl exec -- git status, then commit explicitly)' >&2; exit 74; fi && git -C ${shellQuote(remoteWorkspace)} bundle create ${shellQuote(remoteBundle)} HEAD`);
    assertRemoteCommandSuccess(gitResult, "git pull sync bundling");
    const tempDir = mkdtempSync(path.join(tmpdir(), "cube-sandbox-git-output-"));
    const localBundle = path.join(tempDir, `cube-sandbox-git-output-${paths.taskId}.bundle`);
    const warnings = [];
    try {
      await downloadFile(sandbox, remoteBundle, localBundle);
      const received = fetchGitBundleIntoBranch(localBundle, paths.directory, branch);
      const actualBranch = received.branch;
      upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube-sandbox" });
      console.log(`Fetched remote git changes into local branch ${actualBranch}`);
      return { ok: true, mode: "git", branch: actualBranch, requestedBranch: branch, diverged: Boolean(received.diverged), warnings };
    } finally {
      try {
        const cleanupResult = await cubeSandboxExec(sandbox, `rm -f ${shellQuote(remoteBundle)}`);
        if (typeof cleanupResult?.exitCode === "number" && cleanupResult.exitCode !== 0) warnings.push(`Failed to clean remote git bundle ${remoteBundle}`);
      } catch (error) { warnings.push(`Failed to clean remote git bundle ${remoteBundle}: ${error?.message ?? error}`); }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const requestedRemotePath = options["remote-path"] ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath;
  assertSafeRemoteTransferPath(requestedRemotePath);
  const remotePath = toRemoteAbsolute(requestedRemotePath, remoteHome);
  const resolvedRemotePath = await resolveRemoteTransferPathViaExec((command) => cubeSandboxExec(sandbox, command), remotePath);

  // Single-file fast path (new relative to Daytona): auto-detected when the
  // remote path is not a directory, using sbx.files.read directly with no tar
  // step at all.
  let remoteInfo;
  try { remoteInfo = await sandbox.files.getInfo(resolvedRemotePath); }
  catch (error) { throw new Error(`Remote path not found or unreadable: ${resolvedRemotePath} (${error?.message ?? error})`); }
  if (remoteInfo.type !== "dir") {
    assertNotSensitiveSingleFile(path.basename(resolvedRemotePath), mode, includeSensitive);
    const outputDir = path.resolve(options.output ?? paths.localArtifactsPath);
    assertSafeLocalOutputDir(outputDir, path.join(paths.directory, ".sandbox-ctl"));
    mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, path.basename(resolvedRemotePath));
    if (existsSync(output)) {
      if (statSync(output).isDirectory()) throw new Error(`Transfer output must be a file, got a directory: ${output}`);
      if (!options.overwrite) throw new Error(`Transfer output already exists; pass --overwrite: ${output}`);
    }
    await downloadFile(sandbox, resolvedRemotePath, output);
    console.log(`Downloaded file to ${output}`);
    return { ok: true, mode: "file", output };
  }

  const output = path.resolve(options.output ?? paths.localArtifactsPath);
  const overwrite = Boolean(options.overwrite);
  prepareTransferOutput(output, path.join(paths.directory, ".sandbox-ctl"), overwrite);
  const remoteBundle = `/tmp/cube-sandbox-artifacts-${paths.taskId}.tar.gz`;
  const exclusions = mode === "full" ? ["--exclude=.sandbox-ctl"] : ["--exclude=.env*", "--exclude=.git", "--exclude=.sandbox-ctl", "--exclude=node_modules", "--exclude=.claude", "--exclude=.opencode-state", "--exclude=.daytona", "--exclude=dist", "--exclude=build", "--exclude=*.log", "--exclude=logs"];
  const tarResult = await cubeSandboxExec(sandbox, `tar -czf ${shellQuote(remoteBundle)} ${exclusions.join(" ")} -C ${shellQuote(resolvedRemotePath)} .`);
  assertRemoteCommandSuccess(tarResult, "pull artifact bundling");
  const tempDir = mkdtempSync(path.join(tmpdir(), "cube-sandbox-output-"));
  const localBundle = path.join(tempDir, `cube-sandbox-output-${paths.taskId}.tar.gz`);
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
  // Cube has no signed/expiring preview URL concept (confirmed against the
  // live cluster: the sandbox hostname itself, once DNS/TLS/proxy are wired
  // for the target domain, is the routable preview URL for as long as the
  // sandbox and its listening process are alive) — fail loud instead of
  // silently ignoring a Daytona-only flag.
  if (options["expires-in"]) throw new Error("preview --expires-in is not supported by the Cube Sandbox adapter: Cube Sandbox has no signed/expiring preview URL concept.");
  const port = parsePort(options.port);
  const { sandbox } = await requireSandbox(options);
  const host = sandbox.getHost(port);
  if (!host) throw new Error("Sandbox did not return a preview host.");
  const url = `https://${host}`;
  const result = { port, url };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function handleDown(options) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) throw new Error("No Cube Sandbox binding found for this directory.");
  const client = options.client ?? await createClient();
  let info = null;
  try { info = await client.getInfo(paths.binding.sandboxId); }
  catch (error) { if (!isNotFoundError(error)) throw error; }
  if (info && options.requireManagedPolicy) assertManagedSandboxInfo(info, paths.binding.projectIdentity);
  const killed = await client.kill(paths.binding.sandboxId);
  // `--keep-state` here means "keep the binding entry" — Cube Sandbox has no separate
  // legacy state file the way Daytona does, the binding *is* the state.
  if (!options["keep-state"]) removeBinding(paths.directory, paths.binding.name);
  const result = { sandboxId: paths.binding.sandboxId, name: paths.binding.name, killed: Boolean(killed), stateKept: Boolean(options["keep-state"]) };
  console.log(options["keep-state"] ? "Sandbox deleted; binding kept." : "Sandbox deleted; binding removed.");
  return result;
}

async function handlePause(options = {}) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) throw new Error("No Cube Sandbox binding found for this directory.");
  const client = options.client ?? await createClient();
  let info;
  try {
    if (typeof client.getInfo !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose getInfo; cannot verify pause ownership");
    info = await client.getInfo(paths.binding.sandboxId);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube Sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  if (options.requireManagedPolicy) assertManagedSandboxInfo(info, paths.binding.projectIdentity);
  const currentState = String(info?.state ?? "").toLowerCase();
  if (currentState === "paused") {
    await invalidateDaemonConnection(paths.binding.sandboxId, options);
    const result = { ok: true, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: info.state, alreadyPaused: true, binding: paths.binding };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (typeof client.pause !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose pause");
  // Evict before pausing so an old/incompatible daemon cannot leave the
  // sandbox paused while this command reports an invalidation failure.
  await invalidateDaemonConnection(paths.binding.sandboxId, options);
  try {
    await client.pause(paths.binding.sandboxId, { keepMemory: true });
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube Sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  const result = { ok: true, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: "paused", alreadyPaused: false, binding: paths.binding };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function handleResume(options = {}) {
  const paths = resolveProjectPaths(options);
  if (!paths.binding) throw new Error("No Cube Sandbox binding found for this directory.");
  const client = options.client ?? await createClient();
  let info;
  try {
    if (typeof client.getInfo !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose getInfo; cannot verify resume ownership");
    info = await client.getInfo(paths.binding.sandboxId);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube Sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  if (options.requireManagedPolicy) assertManagedSandboxInfo(info, paths.binding.projectIdentity);
  const currentState = String(info?.state ?? "").toLowerCase();
  // Cube/e2b resumes a paused sandbox by connecting to it. Evict first so
  // the following daemon exec necessarily establishes a fresh SDK connection.
  await invalidateDaemonConnection(paths.binding.sandboxId, options);
  if (currentState === "running") {
    const result = { ok: true, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: info.state, alreadyRunning: true, binding: paths.binding };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  try {
    if (typeof client.connect !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose connect");
    await client.connect(paths.binding.sandboxId, { timeoutMs: paths.binding.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS });
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube Sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  const result = { ok: true, sandboxId: paths.binding.sandboxId, name: paths.binding.name, state: "running", alreadyRunning: currentState === "running", binding: paths.binding };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function handleList(options = {}) {
  const client = options.client ?? await createClient();
  if (typeof client.list !== "function") throw new Error("Cube Sandbox/e2b SDK does not expose a list API.");
  const paginator = client.list();
  const sandboxes = [];
  while (paginator.hasNext) {
    const items = await paginator.nextItems();
    for (const info of items) sandboxes.push({ id: info.sandboxId, name: info.name, state: info.state, template: info.templateId, startedAt: info.startedAt, endAt: info.endAt });
  }
  const result = { ok: true, sandboxes };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function sanitizeDiagnostic(value, env = {}) {
  let message = sanitizeDiagnosticUrls(value);
  for (const [key, secret] of Object.entries(env)) if (/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|JWT)/i.test(key) && secret && String(secret).length > 3) message = message.split(String(secret)).join("[redacted]");
  return sanitizeDiagnosticUrls(message);
}

async function runDoctorCheck({ createClient: makeClient, env = process.env } = {}) {
  const resolved = resolveCubeSandboxEnv(env);
  const apiKeyConfigured = Boolean(resolved.apiKey);
  const apiUrlConfigured = Boolean(resolved.apiUrl);
  try {
    const client = await makeClient();
    if (!client || typeof client.list !== "function") throw new Error("Cube Sandbox/e2b SDK list API unavailable");
    const paginator = client.list();
    await paginator.nextItems();
    return { apiKeyConfigured, apiUrlConfigured, connected: true, category: "ok" };
  } catch (cause) {
    return { apiKeyConfigured, apiUrlConfigured, connected: false, category: "connection_error", error: sanitizeDiagnostic(cause?.message ?? cause, env) };
  }
}

// Deprecated compatibility name retained for existing callers.
const cubeExec = cubeSandboxExec;

async function handleDoctor(options = {}) {
  try {
    const result = await runDoctorCheck({ createClient: options.createClient ?? createClient, env: process.env });
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

export {
  assertManagedSandboxInfo,
  assertSafeDestructiveRemoteWorkspace,
  createClient,
  resolveSandboxLifecycleClass,
  wrapCubeSandboxClient,
  resolveCubeSandboxEnv,
  cubeSandboxExec,
  cubeExec,
  downloadFile,
  handleDoctor,
  handleConfig,
  handleAdopt,
  handleDown,
  handlePause,
  handleResume,
  handleExec,
  handleExecRecord,
  handleList,
  handlePreview,
  handlePull,
  handlePush,
  handleStatus,
  handleUp,
  isNotFoundError,
  parseArgs,
  parsePort,
  parseNodeCreateResult,
  projectIdentity,
  redactExecFailure,
  requireSandbox,
  resolveProjectPaths,
  resolveSchedulerConfig,
  resolveSchedulerNode,
  resolveRemoteHome,
  runSpawnedSsh,
  createCubeSandboxOnNode,
  runDoctorCheck,
  toRemoteAbsolute,
  uploadFile,
};
