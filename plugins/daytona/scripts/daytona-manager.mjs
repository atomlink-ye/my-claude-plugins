#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const BOOL_FLAGS = ["--help", "--refresh", "--keep-state"];
const STRING_FLAGS = ["--directory", "--task-id", "--snapshot", "--name", "--env-file", "--path", "--remote-path", "--mode", "--cwd", "--output"];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

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

function resolveProjectPaths(options = {}) {
  const directory = path.resolve(options.directory ?? process.cwd());
  const stateDir = path.join(directory, ".daytona");
  const stateFile = path.join(stateDir, "state.json");
  const state = readState(stateFile);
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
  return { directory, stateDir, stateFile, taskId, remoteWorkspacePath, remoteArtifactsPath, localArtifactsPath };
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
  const defaultEnvFile = path.join(paths.directory, ".env.local");
  return existsSync(defaultEnvFile) ? defaultEnvFile : null;
}

function applyDaytonaEnv(env = {}) {
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  if (!process.env.DAYTONA_API_KEY && process.env.DAYTONA_API_TOKEN) process.env.DAYTONA_API_KEY = process.env.DAYTONA_API_TOKEN;
}

function applyProjectEnv(options = {}, paths = resolveProjectPaths(options)) {
  const envFile = resolveEnvFile(options, paths);
  applyDaytonaEnv(envFile ? loadEnvFile(envFile) : {});
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
    "  up [--directory DIR] [--task-id ID] [--snapshot SNAPSHOT] [--name NAME] [--env-file FILE]",
    "  status [--directory DIR] [--refresh] [--env-file FILE]",
    "  push [--directory DIR] [--task-id ID] --path PATH [--remote-path PATH] [--mode bundle]",
    "  exec [--directory DIR] [--cwd PATH] -- COMMAND...",
    "  pull [--directory DIR] [--output DIR] [--remote-path PATH]",
    "  down [--directory DIR] [--keep-state] [--env-file FILE]",
    "",
    "State defaults to .daytona/state.json under --directory or cwd. Git mode is planned; bundle mode is currently required."
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

async function loadDaytonaSdk() {
  try {
    return await import("@daytona/sdk");
  } catch (error) {
    throw new Error("Daytona SDK is required for this command. Install it with: pnpm add @daytona/sdk (or install plugin dependencies).");
  }
}

async function createClient() {
  const sdk = await loadDaytonaSdk();
  const Daytona = sdk.Daytona ?? sdk.default?.Daytona ?? sdk.default;
  if (!Daytona) throw new Error("Could not find Daytona client export in @daytona/sdk.");
  const options = process.env.DAYTONA_API_KEY ? { apiKey: process.env.DAYTONA_API_KEY } : undefined;
  return options ? new Daytona(options) : new Daytona();
}

async function callFirst(target, names, ...args) {
  for (const name of names) if (target && typeof target[name] === "function") return target[name](...args);
  throw new Error(`Daytona SDK object does not expose any of: ${names.join(", ")}`);
}

async function getSandbox(client, sandboxId) {
  if (!sandboxId) return null;
  try { return await callFirst(client, ["get", "getSandbox", "findSandbox"], sandboxId); } catch { return null; }
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

async function sandboxExec(sandbox, command, cwd) {
  if (sandbox.process?.executeCommand) return sandbox.process.executeCommand(command, cwd);
  if (sandbox.process?.exec) return sandbox.process.exec(command, cwd ? { cwd } : undefined);
  if (sandbox.exec) return sandbox.exec(command, cwd ? { cwd } : undefined);
  throw new Error("Sandbox command execution is not supported by this @daytona/sdk version.");
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
  const existing = readState(paths.stateFile);
  const client = await createClient();
  let sandbox = await getSandbox(client, existing?.sandboxId);
  if (!sandbox) {
    const params = { name: options.name, snapshot: options.snapshot, labels: { taskId: paths.taskId } };
    for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
    sandbox = await callFirst(client, ["create", "createSandbox"], params);
  }
  const sandboxId = sandbox.id ?? sandbox.sandboxId ?? sandbox.instanceId;
  const now = new Date().toISOString();
  const state = { taskId: paths.taskId, sandboxId, remoteWorkspacePath: paths.remoteWorkspacePath, remoteArtifactsPath: paths.remoteArtifactsPath, createdAt: existing?.createdAt ?? now, updatedAt: now };
  writeState(paths, state);
  console.log(JSON.stringify(redactStateForDisplay(state), null, 2));
}

async function handleStatus(options) {
  const paths = resolveProjectPaths(options);
  const state = readState(paths.stateFile);
  if (!state) { console.log(`No Daytona state at ${paths.stateFile}`); return; }
  const display = redactStateForDisplay({ ...state, stateFile: paths.stateFile });
  if (options.refresh) {
    applyProjectEnv(options, paths);
    const client = await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    display.sandboxKnownToDaytona = Boolean(sandbox);
  }
  console.log(JSON.stringify(display, null, 2));
}

async function requireSandbox(options) {
  const paths = resolveProjectPaths(options);
  const state = readState(paths.stateFile);
  if (!state?.sandboxId) throw new Error(`No Daytona sandbox state found. Run up first. Expected: ${paths.stateFile}`);
  applyProjectEnv(options, paths);
  const client = await createClient();
  const sandbox = await getSandbox(client, state.sandboxId);
  if (!sandbox) throw new Error(`Sandbox not found or unavailable: ${state.sandboxId}`);
  return { paths, state, sandbox };
}

async function handlePush(options) {
  if ((options.mode ?? "bundle") !== "bundle") throw new Error("Only --mode bundle is implemented; git mode is planned.");
  if (!options.path) throw new Error("push requires --path PATH");
  const { paths, state, sandbox } = await requireSandbox(options);
  const remoteWorkspace = options["remote-path"] ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath;
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
  const artifacts = state.remoteArtifactsPath ?? paths.remoteArtifactsPath;
  const cwd = options.cwd ?? state.remoteWorkspacePath ?? paths.remoteWorkspacePath;
  const cmd = command.map(shellQuote).join(" ");
  const wrapped = `mkdir -p ${shellQuote(artifacts)}; { cd ${shellQuote(cwd)} && ${cmd}; } > ${shellQuote(`${artifacts}/stdout.txt`)} 2> ${shellQuote(`${artifacts}/stderr.txt`)}; code=$?; printf '%s\n' "$code" > ${shellQuote(`${artifacts}/exit-code.txt`)}; printf '{"command":%s,"exitCode":%s,"finishedAt":%s}\n' ${shellQuote(JSON.stringify(cmd))} "$code" ${shellQuote(JSON.stringify(new Date().toISOString()))} > ${shellQuote(`${artifacts}/manifest.json`)}; exit $code`;
  const result = await sandboxExec(sandbox, wrapped, options.cwd);
  if (result?.stdout) process.stdout.write(String(result.stdout));
  if (result?.stderr) process.stderr.write(String(result.stderr));
  if (typeof result?.exitCode === "number") process.exitCode = result.exitCode;
}

async function handlePull(options) {
  const { paths, state, sandbox } = await requireSandbox(options);
  const remotePath = options["remote-path"] ?? state.remoteArtifactsPath ?? paths.remoteArtifactsPath;
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

async function handleDown(options) {
  const paths = resolveProjectPaths(options);
  const state = readState(paths.stateFile);
  if (state?.sandboxId) {
    applyProjectEnv(options, paths);
    const client = await createClient();
    const sandbox = await getSandbox(client, state.sandboxId);
    if (sandbox?.delete) await sandbox.delete();
    else await callFirst(client, ["delete", "deleteSandbox", "remove"], state.sandboxId);
  }
  if (!options["keep-state"]) rmSync(paths.stateDir, { recursive: true, force: true });
  console.log(options["keep-state"] ? "Sandbox deleted; state kept." : "Sandbox deleted; state removed.");
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.options.help) { console.log(buildUsage()); return; }
  if (parsed.command === "up") return handleUp(parsed.options);
  if (parsed.command === "status") return handleStatus(parsed.options);
  if (parsed.command === "push") return handlePush(parsed.options);
  if (parsed.command === "exec") return handleExec(parsed.options, parsed.passthrough.length ? parsed.passthrough : parsed.positionals);
  if (parsed.command === "pull") return handlePull(parsed.options);
  if (parsed.command === "down") return handleDown(parsed.options);
  throw new Error(`Unknown command: ${parsed.command}`);
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

export { applyDaytonaEnv, assertRemoteCommandSuccess, buildUsage, createBundle, downloadFile, listTarEntries, loadEnvFile, parseArgs, redactStateForDisplay, resolveEnvFile, resolveProjectPaths, sandboxExec, sanitizeTaskId, shellQuote, uploadFile, validateTarEntries };
