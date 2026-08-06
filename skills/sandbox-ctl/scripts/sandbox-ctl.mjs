#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";

import * as daytonaAdapter from "./adapters/daytona-manager.mjs";
import { configPath, discoverConfig, getActiveBinding, readConfig, resolveBinding, selectBinding } from "./project-config.mjs";

const ADAPTERS = { daytona: daytonaAdapter };
const LIFECYCLE_FLAGS = new Map([
  ["--auto-stop", "autoStopInterval"],
  ["--auto-archive", "autoArchiveInterval"],
  ["--auto-delete", "autoDeleteInterval"],
]);
const BOOLEAN_ADAPTER_FLAGS = new Set(["--refresh", "--keep-state", "--include-git", "--include-preview", "--include-sensitive", "--overwrite"]);

function readValue(argv, index, flag, inline) {
  const value = inline ?? argv[index + 1];
  if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
    throw new Error(`Missing value for option: ${flag}`);
  }
  return { value, next: inline === undefined ? index + 1 : index };
}

function parseInteger(value, source) {
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`Invalid ${source}: expected an integer`);
  return result;
}

function parseLabel(value) {
  const separator = String(value).indexOf("=");
  if (separator <= 0) throw new Error(`Invalid label: expected key=value`);
  const key = String(value).slice(0, separator).trim();
  const labelValue = String(value).slice(separator + 1);
  if (!key) throw new Error("Invalid label: key must not be empty");
  return [key, labelValue];
}

/** Parse sandbox-ctl globals while retaining legacy adapter arguments. */
function parseSandboxCtlArgs(argv = process.argv.slice(2)) {
  const forwarded = [];
  const positionals = [];
  const options = { labels: {} };
  let adapter = "daytona";
  let json = false;
  let command;
  let passthrough = [];
  let afterDashDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterDashDash) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    const [flag, inlineValue] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (flag === "--json") { json = true; continue; }
    if (flag === "--keep") { options.keep = true; continue; }
    if (flag === "--ephemeral") { options.ephemeral = true; continue; }
    if (flag === "--no-use") { options.noUse = true; continue; }
    if (flag === "--include-sensitive") { options.includeSensitive = true; forwarded.push(arg); continue; }
    if (flag === "--adapter") {
      const read = readValue(argv, index, flag, inlineValue);
      adapter = read.value;
      index = read.next;
      continue;
    }
    if (flag === "--label") {
      const read = readValue(argv, index, flag, inlineValue);
      const [key, value] = parseLabel(read.value);
      options.labels[key] = value;
      index = read.next;
      continue;
    }
    if (LIFECYCLE_FLAGS.has(flag)) {
      const read = readValue(argv, index, flag, inlineValue);
      options[LIFECYCLE_FLAGS.get(flag)] = parseInteger(read.value, flag.slice(2));
      index = read.next;
      continue;
    }
    if (BOOLEAN_ADAPTER_FLAGS.has(flag)) {
      forwarded.push(arg);
      continue;
    }
    if (flag === "--sandbox" || flag === "--directory" || flag === "--state-directory" || flag === "--task-id" || flag === "--snapshot" || flag === "--name" || flag === "--env-file" || flag === "--path" || flag === "--remote-path" || flag === "--mode" || flag === "--cwd" || flag === "--output" || flag === "--artifacts" || flag === "--sandbox-id" || flag === "--sandbox-name" || flag === "--class" || flag === "--cpu" || flag === "--memory" || flag === "--disk" || flag === "--gpu" || flag === "--branch" || flag === "--port" || flag === "--expires-in" || flag === "--timeout") {
      const read = readValue(argv, index, flag, inlineValue);
      if (flag === "--sandbox") options.sandbox = read.value;
      else if (flag === "--directory") options.directory = read.value;
      else if (flag === "--sandbox-id" || flag === "--sandbox-name") options.sandboxSelector = read.value;
      else if (flag === "--mode") options.mode = read.value;
      else if (flag === "--name") options.name = read.value;
      forwarded.push(arg);
      if (inlineValue === undefined) { forwarded.push(read.value); index = read.next; }
      continue;
    }
    if (arg.startsWith("--")) {
      // Leave unknown adapter options intact; Daytona will provide the precise error.
      forwarded.push(arg);
      if (inlineValue === undefined && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) forwarded.push(argv[++index]);
      continue;
    }
    if (!command) command = arg;
    else positionals.push(arg);
  }
  if (adapter !== "daytona") throw new Error(`Unknown adapter: ${adapter}. Supported adapters: daytona`);
  return { adapter, json, command, positionals, passthrough, options, forwarded };
}

function resolveCommandAlias(command, subcommand) {
  if (command === "create") return { command: "up", kind: "sandbox" };
  if (command === "delete" || command === "finish") return { command: "down", kind: "task" };
  if (command === "import") return { command: "adopt", kind: "sandbox" };
  if (command === "task" || command === "project") {
    if (subcommand !== "up") throw new Error("project delete/down is deferred; explicit confirmation is required");
    return { command: subcommand, kind: "sandbox" };
  }
  return { command, kind: "sandbox" };
}

function normalizeLifecycleOptions(kind = "task", options = {}) {
  const defaults = { autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60 };
  const normalized = { ...defaults };
  for (const key of ["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval"]) {
    if (options[key] !== undefined) normalized[key] = parseInteger(options[key], key);
  }
  if (normalized.autoStopInterval < 0 || normalized.autoArchiveInterval < 0 || normalized.autoDeleteInterval < -1) {
    throw new Error("Lifecycle intervals must be non-negative (auto-delete may be -1)");
  }
  normalized.ephemeral = Boolean(options.ephemeral);
  if (normalized.ephemeral) normalized.autoDeleteInterval = 0;
  return normalized;
}

function buildLifecycleLabels(kind = "task", labels = {}) {
  return {
    ...labels,
    "sandbox-ctl.managed": "true",
    "sandbox-ctl.kind": "sandbox",
    "sandbox-ctl.adapter": "daytona",
    "sandbox-ctl.policy": "sandbox-v1",
  };
}

function usage() {
  return [
    "Usage: sandbox-ctl [--adapter daytona] [--json] <command> [options]",
    "Commands: up, adopt, status, push, exec, run, pull, preview, smoke-test, down, list, doctor",
    "Deprecated aliases: create, task up, project up (all use the unified up policy)",
    "Binding: use NAME_OR_ID (select active binding)",
    "Lifecycle: --label key=value (repeatable), --auto-stop N, --auto-archive N, --auto-delete N, --ephemeral",
  ].join("\n");
}

async function capture(fn) {
  const logs = [];
  const errors = [];
  const writes = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  console.error = (...args) => errors.push(args.map(String).join(" "));
  process.stdout.write = (chunk, ...args) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...args) => { errors.push(String(chunk)); return true; };
  try { return { result: await fn(), logs, errors, writes }; }
  finally { console.log = oldLog; console.error = oldError; process.stdout.write = oldOut; process.stderr.write = oldErr; }
}

function adapterArgs(parsed, alias) {
  const args = [...parsed.forwarded];
  args.unshift(alias.command);
  return args;
}

function makeRunTaskId(value) {
  return value || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRunResult({ directory = process.cwd(), bindingName = makeRunTaskId(), sandboxId = null, exitCode = 125, artifactPath = null, retained = false, warnings = [], nextActions = [], stdout = "", stderr = "", error } = {}) {
  return {
    ok: false,
    command: "run",
    adapter: "daytona",
    bindingName,
    configPath: discoverConfig(directory) ?? configPath(directory),
    sandboxId,
    exitCode,
    artifactPath,
    retained,
    warnings,
    nextActions,
    stdout,
    stderr,
    ...(error ? { error: sanitizeError(error) } : {}),
  };
}

function makeControlFailure({ directory = process.cwd(), bindingName, error, ...rest } = {}) {
  return makeRunResult({ directory, bindingName, error, exitCode: 125, ...rest });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function captureExecStreams(fn) {
  const stdout = [];
  const stderr = [];
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try { return { result: await fn(), stdout: stdout.join(""), stderr: stderr.join("") }; }
  finally { process.stdout.write = oldOut; process.stderr.write = oldErr; }
}

async function invokeRun(parsed, adapter) {
  let adapterParsed;
  try {
    adapterParsed = adapter.parseArgs(adapterArgs(parsed, { command: "up" }));
  } catch (error) {
    return makeControlFailure({ directory: parsed.options.directory ?? process.cwd(), error });
  }
  const directory = parsed.options.directory ?? adapterParsed.options.directory ?? process.cwd();
  const bindingName = makeRunTaskId();
  const selector = parsed.options.sandbox ?? parsed.options.sandboxSelector ?? adapterParsed.options.sandbox ?? adapterParsed.options["sandbox-id"] ?? adapterParsed.options["sandbox-name"];
  const transferMode = parsed.options.mode ?? adapterParsed.options.mode;
  const includeSensitive = Boolean(parsed.options.includeSensitive ?? adapterParsed.options.includeSensitive ?? adapterParsed.options["include-sensitive"]);
  if (selector) return makeControlFailure({ directory, bindingName, error: "run does not accept --sandbox, --sandbox-id, or --sandbox-name; it always creates a unique run-* binding" });
  if (transferMode && transferMode !== "bundle") return makeControlFailure({ directory, bindingName, error: "run only supports safe bundle transfer; --mode full/git is not allowed" });
  if (includeSensitive) return makeControlFailure({ directory, bindingName, error: "run does not accept --include-sensitive; credentials cannot be included" });
  const commonOptions = {
    ...adapterParsed.options,
    directory,
    json: Boolean(parsed.json),
  };
  let lifecycle;
  try { lifecycle = normalizeLifecycleOptions("task", parsed.options); }
  catch (error) { return makeControlFailure({ directory, bindingName, error }); }
  const upOptions = {
    ...commonOptions,
    name: bindingName,
    noUse: true,
    ignoreActiveBinding: true,
    ignoreState: true,
    labels: buildLifecycleLabels("sandbox", parsed.options.labels),
    ...lifecycle,
    requireManagedPolicy: true,
    expectedKind: "sandbox",
    expectedLifecycle: lifecycle,
  };
  const command = parsed.passthrough.length ? parsed.passthrough : adapterParsed.passthrough.length ? adapterParsed.passthrough : adapterParsed.positionals;
  if (!command.length) return makeControlFailure({ directory, bindingName, error: "run requires a command after --" });
  const artifactPath = parsed.options.artifacts ?? parsed.options.output ?? adapterParsed.options.artifacts ?? adapterParsed.options.output ?? null;
  if (artifactPath) commonOptions.artifacts = artifactPath;
  const boundOptions = {
    ...commonOptions,
    sandbox: bindingName,
    ignoreActiveBinding: false,
    ignoreState: false,
    requireManagedPolicy: true,
    expectedKind: "sandbox",
    expectedLifecycle: lifecycle,
  };
  const warnings = [];
  let sandboxId;
  let upAttempted = false;
  let failure;
  let exitCode = 0;
  let execResult;
  let retained = false;
  const nextActions = [];
  try {
    upAttempted = true;
    const upResult = await adapter.handleUp(upOptions);
    sandboxId = upResult?.sandboxId ?? upResult?.id;
    await adapter.handlePush({ ...boundOptions, path: adapterParsed.options.path ?? directory });
    const capturedExec = await captureExecStreams(() => adapter.handleExec(boundOptions, command));
    execResult = capturedExec.result;
    execResult = {
      ...(execResult ?? {}),
      stdout: capturedExec.stdout || execResult?.stdout || "",
      stderr: capturedExec.stderr || execResult?.stderr || "",
    };
    exitCode = typeof execResult?.exitCode === "number" ? execResult.exitCode : 0;
    if (exitCode !== 0) failure = new Error(`Remote command exited with code ${exitCode}`);
  } catch (error) {
    failure = error;
    if (!sandboxId && error?.sandboxId) sandboxId = error.sandboxId;
    if (Array.isArray(error?.nextActions)) nextActions.push(...error.nextActions);
    if (!exitCode) exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 125;
  } finally {
    const hasRecoveryActions = nextActions.length > 0;
    let bindingRecorded = false;
    try { bindingRecorded = Boolean(resolveBinding(readConfig(directory) ?? { sandboxes: {} }, bindingName)); } catch { /* recovery path remains conservative */ }
    retained = Boolean(failure && parsed.options.keep);
    let cleanupSucceeded = false;
    if (upAttempted && !retained && (!hasRecoveryActions || bindingRecorded)) {
      try { await adapter.handleDown(boundOptions); }
      catch (error) {
        retained = true;
        warnings.push(sanitizeError(`Cleanup failed for sandbox ${sandboxId ?? "unknown"}: ${error?.message ?? error}`));
      }
      if (!retained) cleanupSucceeded = true;
    }
    if (hasRecoveryActions && cleanupSucceeded) nextActions.length = 0;
    if (hasRecoveryActions && !cleanupSucceeded) retained = true;
    if (retained && !nextActions.length) nextActions.push(`sandbox-ctl down --directory ${shellQuote(directory)} --sandbox ${shellQuote(bindingName)}`);
  }
  const result = {
    ...makeRunResult({ directory, bindingName, sandboxId: sandboxId ?? null, exitCode, artifactPath: execResult?.artifactPath ?? artifactPath, retained, warnings, nextActions }),
    ok: !failure && !warnings.length && exitCode === 0,
  };
  if (warnings.length && exitCode === 0) result.exitCode = 125;
  if (execResult?.stdout) result.stdout = sanitizeError(execResult.stdout);
  if (execResult?.stderr) result.stderr = sanitizeError(execResult.stderr);
  if (failure && !result.error) result.error = sanitizeError(failure);
  return result;
}

async function invoke(parsed, adapter, alias) {
  const adapterParsed = adapter.parseArgs(adapterArgs(parsed, alias));
  const options = { ...adapterParsed.options };
  options.json = Boolean(parsed.json);
  options.directory = parsed.options.directory ?? options.directory ?? process.cwd();
  if (parsed.options.name !== undefined) options.name = parsed.options.name;
  if (parsed.options.noUse) options.noUse = true;
  if (alias.command !== "up" && alias.command !== "adopt" && alias.command !== "list" && alias.command !== "doctor") {
    const config = readConfig(options.directory);
    const selected = parsed.options.sandbox
      ? resolveBinding(config ?? { sandboxes: {} }, parsed.options.sandbox)
      : getActiveBinding(options.directory);
    if (parsed.options.sandbox && !selected) throw new Error(`Sandbox binding not found: ${parsed.options.sandbox}`);
    if (selected) {
      options["sandbox-id"] = selected.sandboxId;
      options["remote-path"] = selected.remoteWorkspace;
      options.sandboxId = selected.sandboxId;
      options.remoteWorkspace = selected.remoteWorkspace;
    }
  }
  if (alias.command === "up") {
    const lifecycle = normalizeLifecycleOptions(alias.kind, parsed.options);
    Object.assign(options, lifecycle, {
      labels: buildLifecycleLabels(alias.kind, parsed.options.labels),
      requireManagedPolicy: true,
      expectedKind: "sandbox",
      expectedLifecycle: lifecycle,
    });
  }
  if (alias.command === "down") {
    Object.assign(options, { requireManagedPolicy: true, expectedKind: "sandbox" });
  }
  if (alias.command === "push" && parsed.positionals[0] && options.path === undefined) options.path = parsed.positionals[0];
  if (alias.command === "pull" && parsed.positionals[0]) options["remote-path"] = parsed.positionals[0];
  if (alias.command === "use") return selectBinding(options.directory, parsed.positionals[0] ?? parsed.options.sandbox);
  const handler = {
    up: adapter.handleUp,
    down: adapter.handleDown,
    adopt: adapter.handleAdopt,
    status: adapter.handleStatus,
    push: adapter.handlePush,
    exec: (opts) => adapter.handleExec(opts, parsed.passthrough.length ? parsed.passthrough : (adapterParsed.passthrough.length ? adapterParsed.passthrough : adapterParsed.positionals)),
    pull: adapter.handlePull,
    preview: adapter.handlePreview,
    "smoke-test": adapter.handleSmokeTest,
    list: adapter.handleList,
    doctor: adapter.handleDoctor,
  }[alias.command];
  if (!handler) throw new Error(`Unknown command: ${parsed.command}`);
  return handler(options);
}

/** Run the command. The optional dependency injection keeps unit tests offline. */
async function runSandboxCtl(argv = process.argv.slice(2), { adapter = daytonaAdapter } = {}) {
  const requestedJson = argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
  try {
    const parsed = parseSandboxCtlArgs(argv);
    if (parsed.options.help || !parsed.command) {
      if (parsed.json) console.log(JSON.stringify({ ok: true, command: "help", adapter: parsed.adapter, usage: usage() }));
      else console.log(usage());
      return { ok: true, command: "help", adapter: parsed.adapter };
    }
    const deprecatedAlias = parsed.command === "create" || parsed.command === "task" || parsed.command === "project";
    const alias = parsed.command === "use" ? { command: "use", kind: "sandbox" } : resolveCommandAlias(parsed.command, parsed.positionals[0]);
    const command = alias.command;
    const runner = command === "run" ? () => invokeRun(parsed, adapter) : () => invoke(parsed, adapter, alias);
    const jsonResult = (parsed.json || command === "run") ? await capture(runner) : { result: await runner(), logs: [], errors: [], writes: [] };
    const resultObject = jsonResult.result && typeof jsonResult.result === "object" ? jsonResult.result : {};
    const exitCode = (command === "exec" || command === "run") && typeof resultObject.exitCode === "number" ? resultObject.exitCode : (resultObject.ok === false ? 1 : 0);
    if ((command === "exec" || command === "run") && typeof resultObject.exitCode === "number") process.exitCode = exitCode;
    if (resultObject.ok === false && !((command === "exec" || command === "run") && typeof resultObject.exitCode === "number")) process.exitCode = 1;
    if (!parsed.json && command === "exec" && resultObject.error) {
      if (resultObject.warning) console.error(sanitizeError(resultObject.warning));
      console.error(sanitizeError(resultObject.error));
    }
    if (deprecatedAlias && !parsed.json) console.log(`Deprecated alias: ${parsed.command}${parsed.command === "create" ? "" : " up"}; use sandbox-ctl up instead.`);
    if (parsed.json) {
      const payload = { ok: exitCode === 0, command, adapter: parsed.adapter, ...resultObject, ...(command === "exec" ? { exitCode } : {}) };
      if (deprecatedAlias) payload.warnings = [...(Array.isArray(resultObject.warnings) ? resultObject.warnings : []), `Deprecated alias: ${parsed.command}; use sandbox-ctl up instead.`];
      if (command === "exec" || command === "run") {
        const stdout = resultObject.stdout ?? [...jsonResult.writes, ...jsonResult.logs].join("");
        const stderr = resultObject.stderr ?? jsonResult.errors.join("");
        if (stdout) payload.stdout = sanitizeError(stdout);
        if (stderr) payload.stderr = sanitizeError(stderr);
      }
      console.log(JSON.stringify(payload));
      return payload;
    }
    if (command === "run") console.log(JSON.stringify(resultObject, null, 2));
    return jsonResult.result;
  } catch (error) {
    if (findTopLevelCommand(argv) === "run") {
      const payload = makeControlFailure({ directory: findTopLevelDirectory(argv), error });
      process.exitCode = 125;
      if (requestedJson) console.log(JSON.stringify(payload));
      else console.error(payload.error);
      return payload;
    }
    if (!requestedJson) throw error;
    const payload = { ok: false, command: findTopLevelCommand(argv) ?? "unknown", adapter: "daytona", error: sanitizeError(error), sandboxId: error?.sandboxId ?? null, nextActions: error?.nextActions ?? [] };
    process.exitCode = 1;
    console.log(JSON.stringify(payload));
    return payload;
  }
}

function sanitizeError(error) {
  let message = String(error?.message ?? error);
  for (const [key, value] of Object.entries(process.env)) if (/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|JWT)/i.test(key) && value && value.length > 3) message = message.split(value).join("[redacted]");
  message = message.replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[redacted]@[redacted]@");
  return message;
}

const TOP_LEVEL_VALUE_FLAGS = new Set(["--adapter", "--label", "--auto-stop", "--auto-archive", "--auto-delete", "--sandbox", "--sandbox-id", "--sandbox-name", "--directory", "--name", "--path", "--output", "--artifacts", "--mode", "--snapshot", "--env-file"]);

function findTopLevelCommand(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (!arg.startsWith("-")) return arg;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (TOP_LEVEL_VALUE_FLAGS.has(flag) && !arg.includes("=")) index += 1;
  }
  return null;
}

function findTopLevelDirectory(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") break;
    if (argv[index] === "--directory" && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
    if (argv[index].startsWith("--directory=")) return argv[index].slice("--directory=".length);
  }
  return process.cwd();
}

function isSameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}

async function loadDirectAdapter() {
  const modulePath = process.env.SANDBOX_CTL_ADAPTER_MODULE;
  if (!modulePath) return daytonaAdapter;
  return import(pathToFileURL(path.resolve(modulePath)).href);
}

const isDirectExecution = isSameRealPath(process.argv[1] ?? "", fileURLToPath(import.meta.url));
if (isDirectExecution) loadDirectAdapter().then((adapter) => runSandboxCtl(process.argv.slice(2), { adapter })).catch((error) => {
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) console.log(JSON.stringify({ ok: false, command: "unknown", adapter: "daytona", error: sanitizeError(error) }));
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

export { buildLifecycleLabels, normalizeLifecycleOptions, parseSandboxCtlArgs, resolveCommandAlias, runSandboxCtl, usage };
