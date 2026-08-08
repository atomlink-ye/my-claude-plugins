#!/usr/bin/env node

// Cube adapter: mirrors adapters/daytona-manager.mjs's exported handler surface
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
//     `Sandbox.getInfo`, `Sandbox.kill`) plus instance methods on a connected
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
//     getters, so `cubeExec()` below duck-types on that shape instead of doing
//     an `instanceof CommandExitError` check — this also makes it trivial for
//     unit tests to simulate a non-zero remote exit without needing the real
//     SDK class loaded (see cube-manager.test.mjs).
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
//   - Sandbox lifecycle is a single `timeoutMs` + optional
//     `lifecycle: { onTimeout: 'pause' | 'kill', autoResume }` — there is no
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
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

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

const BOOL_FLAGS = ["--help", "--include-sensitive", "--overwrite", "--committed-only", "--require-clean", "--keep-state", "--no-use"];
const STRING_FLAGS = ["--directory", "--task-id", "--template", "--name", "--path", "--remote-path", "--mode", "--cwd", "--output", "--artifacts", "--sandbox", "--sandbox-id", "--sandbox-name", "--branch", "--port", "--timeout"];
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
  return parseArgsGeneric(argv, config);
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
 * existing sandbox binding for this project — the Cube-adapter analog of
 * Daytona's resolveProjectPaths(). Unlike Daytona, Cube has no legacy
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
  const localArtifactsPath = path.join(directory, "artifacts", "cube", taskId);
  const resolvedRemoteWorkspace = options.remoteWorkspace ?? options["remote-path"] ?? binding?.remoteWorkspace ?? remoteWorkspacePath;
  const resolvedSandboxId = options.sandboxId ?? options["sandbox-id"] ?? binding?.sandboxId;
  return { directory, taskId, remoteWorkspacePath: resolvedRemoteWorkspace, localArtifactsPath, config, binding, sandboxId: resolvedSandboxId };
}

async function loadCubeSdk() {
  try {
    return await import("e2b");
  } catch (directImportError) {
    throw new Error(`e2b SDK is required for this command. Install it with: pnpm add e2b (or install plugin dependencies). Original error: ${directImportError?.message ?? directImportError}`);
  }
}

/** Resolve Cube's connection env vars, bridging the cluster-side CUBE_* names into the SDK-native E2B_* names the `e2b` package itself reads (mirrors Daytona's createClient() building an explicit options bag from env). */
function resolveCubeEnv() {
  const apiKey = process.env.CUBE_API_KEY ?? process.env.E2B_API_KEY;
  const apiUrl = process.env.CUBE_API_URL ?? process.env.E2B_API_URL;
  if (apiKey && !process.env.E2B_API_KEY) process.env.E2B_API_KEY = apiKey;
  if (apiUrl && !process.env.E2B_API_URL) process.env.E2B_API_URL = apiUrl;
  return { apiKey, apiUrl };
}

/**
 * Cube-adapter analog of Daytona's createClient(): there is no instantiated
 * client object in the `e2b` SDK (everything is a static method on the
 * `Sandbox` class), so this resolves/validates connection env vars and
 * returns the `Sandbox` class itself as the "client" — every handler below
 * calls `client.create(...)`, `client.connect(...)`, `client.list(...)`,
 * `client.getInfo(...)`, `client.kill(...)` exactly as it would on the real
 * SDK export, which also makes it trivial to inject a fake object with the
 * same shape via `options.client` in tests.
 */
async function createClient() {
  const { apiKey, apiUrl } = resolveCubeEnv();
  if (!apiKey) throw new Error("Cube API key is required. Set CUBE_API_KEY or E2B_API_KEY.");
  if (!apiUrl) throw new Error("Cube API URL is required. Set CUBE_API_URL or E2B_API_URL to the operator's self-hosted Cube endpoint (a tunnel/WireGuard address) — do not rely on the SDK's public e2b.dev default.");
  const sdk = await loadCubeSdk();
  const Sandbox = sdk.Sandbox ?? sdk.default;
  if (!Sandbox) throw new Error("Could not find Sandbox client export in e2b.");
  return Sandbox;
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
async function cubeExec(sandbox, cmd, opts = {}) {
  try {
    const result = await sandbox.commands.run(cmd, { background: false, ...opts });
    return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    if (typeof error?.exitCode === "number" && typeof error?.stdout === "string" && typeof error?.stderr === "string") {
      return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
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
    const result = await cubeExec(sandbox, `sh -lc ${shellQuote(command)}`);
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

function createCubeBundle(...args) {
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
 * Cube-adapter equivalent of Daytona's assertManagedSandbox()/labels check.
 * Cube has no built-in label metadata system like Daytona, but `Sandbox.create`
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
  if (!paths.binding) throw new Error("No Cube sandbox binding found for this directory. Run up first.");
  const client = options.client ?? await createClient();
  let sandbox;
  try {
    sandbox = await client.connect(paths.binding.sandboxId);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Cube sandbox not found or unavailable: ${paths.binding.sandboxId}`);
    throw error;
  }
  const remoteHome = await resolveRemoteHome(sandbox);
  return { paths, sandbox, remoteHome };
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

async function handleUp(options) {
  let paths = resolveProjectPaths(options);
  if (options.name && !paths.config?.sandboxes?.[options.name]) paths = resolveProjectPaths({ ...options, ignoreActiveBinding: true });
  else if (options.name) paths = resolveProjectPaths({ ...options, sandbox: options.name });
  const client = options.client ?? await createClient();
  const existingBinding = paths.binding;
  let sandbox = null;
  if (existingBinding?.sandboxId) {
    try { sandbox = await client.connect(existingBinding.sandboxId); }
    catch (error) { if (!isNotFoundError(error)) throw error; sandbox = null; }
  }
  const template = options.template ?? options.snapshot ?? existingBinding?.template;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  if (!sandbox) {
    const metadata = {
      "sandbox-ctl.managed": "true",
      "sandbox-ctl.kind": "sandbox",
      "sandbox-ctl.adapter": "cube",
      "sandbox-ctl.policy": "sandbox-v1",
      "sandbox-ctl.project": projectIdentity(paths.directory),
      taskId: paths.taskId,
    };
    sandbox = await client.create({ template, timeoutMs, metadata });
  }
  const sandboxId = sandbox.sandboxId ?? sandbox.id;
  const bindingName = options.name ?? existingBinding?.name ?? paths.taskId;
  const remoteHome = await resolveRemoteHome(sandbox);
  const remoteWorkspace = toRemoteAbsolute(paths.remoteWorkspacePath, remoteHome);
  const workspaceResult = await cubeExec(sandbox, `mkdir -p ${shellQuote(remoteWorkspace)}`);
  assertRemoteCommandSuccess(workspaceResult, "workspace initialization");
  const binding = upsertBinding(paths.directory, bindingName, {
    sandboxId,
    remoteWorkspace: paths.remoteWorkspacePath,
    template,
    projectIdentity: projectIdentity(paths.directory),
    name: options.name,
    createdAt: existingBinding?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { use: !options.noUse, adapter: "cube" });
  const warning = `Sandbox lifecycle: Cube enforces a single idle timeout (~${Math.round(timeoutMs / 60000)} minutes here) after which the sandbox is killed by default; there is no Cube/e2b equivalent of Daytona's separate auto-stop/auto-archive/auto-delete timers. Any data not pulled back before the timeout is lost.`;
  const result = { ok: true, sandboxId, name: bindingName, remoteWorkspace: paths.remoteWorkspacePath, template, timeoutMs, warning, binding };
  console.log(JSON.stringify(result, null, 2));
  if (!options.json) console.log(warning);
  return result;
}

async function handleExec(options, command) {
  if (!command.length) throw new Error("exec requires a command after --");
  let sandboxInfo;
  try {
    sandboxInfo = await requireSandbox(options);
  } catch (error) {
    return { exitCode: 125, stdout: "", stderr: "", error: redactExecFailure(error) };
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  let exitCode;
  try {
    const result = await sandbox.commands.run(cmd, {
      background: false,
      cwd,
      timeoutMs,
      onStdout: (chunk) => emit("stdout", chunk),
      onStderr: (chunk) => emit("stderr", chunk),
    });
    exitCode = remoteExitCode(result?.exitCode) ?? 0;
  } catch (error) {
    // Duck-typed CommandExitError (see cubeExec's header note): stdout/stderr
    // were already streamed via onStdout/onStderr by the time wait() rejects,
    // so we only need the exit code here — re-appending error.stdout/stderr
    // would double the buffered text.
    if (typeof error?.exitCode === "number" && typeof error?.stdout === "string" && typeof error?.stderr === "string") {
      exitCode = remoteExitCode(error.exitCode) ?? 125;
    } else {
      return { exitCode: 125, stdout: stdout.join(""), stderr: stderr.join(""), error: redactExecFailure(error) };
    }
  }
  const result = { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  if (options.artifacts) {
    try { result.artifactPath = writeExecArtifacts(options.artifacts, { ...result, command, cwd }); }
    catch (error) { return { ...result, exitCode: 125, error: redactExecFailure(error) }; }
  }
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
  const { paths, sandbox, remoteHome } = await requireSandbox(options);
  const remoteWorkspace = toRemoteAbsolute(options["remote-path"] ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath, remoteHome);

  if (mode === "git") {
    const defaultBranch = `sandbox-ctl/${paths.binding.name ?? paths.taskId}`;
    const branch = validateGitBranch(options.branch ?? paths.binding.sync?.branch ?? defaultBranch);
    const safeRemoteWorkspace = assertSafeDestructiveRemoteWorkspace(remoteWorkspace, remoteHome);
    const bindingName = paths.binding.name ?? paths.taskId;
    const { bundlePath, sourceHead, includedWip, dirty, wipSummary, cleanup } = createGitBundle(options.path, paths.taskId, { ...options, branch, binding: bindingName });
    try {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const remoteBundle = `/tmp/cube-git-input-${paths.taskId}-${nonce}.bundle`;
      await uploadFile(sandbox, bundlePath, remoteBundle);
      const tempRefName = `refs/sandbox-ctl-sync/push-${paths.taskId}-${nonce}`;
      const markerSource = shellQuote(sourceHead);
      const markerBranch = shellQuote(branch);
      const markerBranchLine = shellQuote(`branch=${branch}`);
      const markerBindingLine = shellQuote(`binding=${bindingName}`);
      const markerSourceLine = shellQuote(`source=${sourceHead}`);
      const result = await cubeExec(sandbox, `${remoteEnsureGitCommand()} && set -eu
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
      upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube" });
      console.log(`Uploaded git bundle to ${safeRemoteWorkspace} on branch ${branch}${warnings.length ? `\nWarning: ${warnings[0]}` : ""}`);
      return { ok: true, mode: "git", remoteWorkspace: safeRemoteWorkspace, branch, sourceHead, snapshotHead: remoteSnapshotHead, includedWip, wipSummary, warnings };
    } finally { cleanup(); }
  }

  const localAbs = path.resolve(options.path);
  if (!existsSync(localAbs)) throw new Error(`Path not found: ${localAbs}`);
  assertSafeLocalTransferFile(localAbs);

  // Single-file fast path (new relative to Daytona): auto-detected when the
  // local path is not a directory, using sbx.files.write directly with no tar
  // step at all.
  if (!statSync(localAbs).isDirectory()) {
    assertNotSensitiveSingleFile(path.basename(localAbs), mode, includeSensitive);
    const requestedRemotePath = options["remote-path"];
    const explicitRemoteTarget = requestedRemotePath === paths.binding.remoteWorkspace ? undefined : requestedRemotePath;
    const remoteTarget = resolveSingleFileRemoteTarget(explicitRemoteTarget, remoteWorkspace, path.basename(localAbs), remoteHome);
    await uploadFile(sandbox, localAbs, remoteTarget);
    console.log(`Uploaded file to ${remoteTarget}`);
    return { ok: true, mode: "file", remoteWorkspace: remoteTarget };
  }

  const { bundlePath, cleanup } = createCubeBundle(options.path, paths.taskId, { mode, includeSensitive });
  try {
    const remoteBundle = `/tmp/cube-input-${paths.taskId}.tar.gz`;
    await uploadFile(sandbox, bundlePath, remoteBundle);
    const result = await cubeExec(sandbox, `mkdir -p ${shellQuote(remoteWorkspace)} && tar -xzf ${shellQuote(remoteBundle)} -C ${shellQuote(remoteWorkspace)}`);
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
    const remoteBundle = `/tmp/cube-git-output-${paths.taskId}.bundle`;
    const gitResult = await cubeExec(sandbox, `${remoteEnsureGitCommand()} && if [ ! -d ${shellQuote(remoteWorkspace)} ] || ! git -C ${shellQuote(remoteWorkspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo 'remote workspace is not a git repository' >&2; exit 73; fi && if [ -n "$(git -C ${shellQuote(remoteWorkspace)} status --porcelain --untracked-files=all)" ]; then echo 'remote git workspace is dirty; commit changes before pull (run sandbox-ctl exec -- git status, then commit explicitly)' >&2; exit 74; fi && git -C ${shellQuote(remoteWorkspace)} bundle create ${shellQuote(remoteBundle)} HEAD`);
    assertRemoteCommandSuccess(gitResult, "git pull sync bundling");
    const tempDir = mkdtempSync(path.join(tmpdir(), "cube-git-output-"));
    const localBundle = path.join(tempDir, `cube-git-output-${paths.taskId}.bundle`);
    const warnings = [];
    try {
      await downloadFile(sandbox, remoteBundle, localBundle);
      const received = fetchGitBundleIntoBranch(localBundle, paths.directory, branch);
      const actualBranch = received.branch;
      upsertBinding(paths.directory, paths.binding.name, { sync: { mode: "git", branch }, updatedAt: new Date().toISOString() }, { use: false, adapter: "cube" });
      console.log(`Fetched remote git changes into local branch ${actualBranch}`);
      return { ok: true, mode: "git", branch: actualBranch, requestedBranch: branch, diverged: Boolean(received.diverged), warnings };
    } finally {
      try {
        const cleanupResult = await cubeExec(sandbox, `rm -f ${shellQuote(remoteBundle)}`);
        if (typeof cleanupResult?.exitCode === "number" && cleanupResult.exitCode !== 0) warnings.push(`Failed to clean remote git bundle ${remoteBundle}`);
      } catch (error) { warnings.push(`Failed to clean remote git bundle ${remoteBundle}: ${error?.message ?? error}`); }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const requestedRemotePath = options["remote-path"] ?? paths.binding.remoteWorkspace ?? paths.remoteWorkspacePath;
  assertSafeRemoteTransferPath(requestedRemotePath);
  const remotePath = toRemoteAbsolute(requestedRemotePath, remoteHome);
  const resolvedRemotePath = await resolveRemoteTransferPathViaExec((command) => cubeExec(sandbox, command), remotePath);

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
  const remoteBundle = `/tmp/cube-artifacts-${paths.taskId}.tar.gz`;
  const exclusions = mode === "full" ? ["--exclude=.sandbox-ctl"] : ["--exclude=.env*", "--exclude=.git", "--exclude=.sandbox-ctl", "--exclude=node_modules", "--exclude=.claude", "--exclude=.opencode-state", "--exclude=.daytona", "--exclude=dist", "--exclude=build", "--exclude=*.log", "--exclude=logs"];
  const tarResult = await cubeExec(sandbox, `tar -czf ${shellQuote(remoteBundle)} ${exclusions.join(" ")} -C ${shellQuote(resolvedRemotePath)} .`);
  assertRemoteCommandSuccess(tarResult, "pull artifact bundling");
  const tempDir = mkdtempSync(path.join(tmpdir(), "cube-output-"));
  const localBundle = path.join(tempDir, `cube-output-${paths.taskId}.tar.gz`);
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
  if (options["expires-in"]) throw new Error("preview --expires-in is not supported by the Cube adapter: Cube has no signed/expiring preview URL concept.");
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
  if (!paths.binding) throw new Error("No Cube sandbox binding found for this directory.");
  const client = options.client ?? await createClient();
  let info = null;
  try { info = await client.getInfo(paths.binding.sandboxId); }
  catch (error) { if (!isNotFoundError(error)) throw error; }
  if (info && options.requireManagedPolicy) assertManagedSandboxInfo(info, paths.binding.projectIdentity);
  const killed = await client.kill(paths.binding.sandboxId);
  // `--keep-state` here means "keep the binding entry" — Cube has no separate
  // legacy state file the way Daytona does, the binding *is* the state.
  if (!options["keep-state"]) removeBinding(paths.directory, paths.binding.name);
  const result = { sandboxId: paths.binding.sandboxId, name: paths.binding.name, killed: Boolean(killed), stateKept: Boolean(options["keep-state"]) };
  console.log(options["keep-state"] ? "Sandbox deleted; binding kept." : "Sandbox deleted; binding removed.");
  return result;
}

async function handleList(options = {}) {
  const client = options.client ?? await createClient();
  if (typeof client.list !== "function") throw new Error("Cube/e2b SDK does not expose a list API.");
  const paginator = client.list();
  const sandboxes = [];
  while (paginator.hasNext) {
    const items = await paginator.nextItems();
    for (const info of items) sandboxes.push({ id: info.sandboxId, name: info.name, state: info.state, template: info.templateId });
  }
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
  const apiKeyConfigured = Boolean(env.CUBE_API_KEY || env.E2B_API_KEY);
  const apiUrlConfigured = Boolean(env.CUBE_API_URL || env.E2B_API_URL);
  try {
    const client = await makeClient();
    if (!client || typeof client.list !== "function") throw new Error("Cube/e2b SDK list API unavailable");
    const paginator = client.list();
    await paginator.nextItems();
    return { apiKeyConfigured, apiUrlConfigured, connected: true, category: "ok" };
  } catch (cause) {
    return { apiKeyConfigured, apiUrlConfigured, connected: false, category: "connection_error", error: sanitizeDiagnostic(cause?.message ?? cause, env) };
  }
}

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
  cubeExec,
  downloadFile,
  handleDoctor,
  handleDown,
  handleExec,
  handleList,
  handlePreview,
  handlePull,
  handlePush,
  handleUp,
  isNotFoundError,
  parseArgs,
  parsePort,
  projectIdentity,
  redactExecFailure,
  requireSandbox,
  resolveProjectPaths,
  resolveRemoteHome,
  runDoctorCheck,
  toRemoteAbsolute,
  uploadFile,
};
