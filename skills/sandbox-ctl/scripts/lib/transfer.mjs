// Adapter-agnostic archive/bundle transfer logic shared by every sandbox-ctl
// adapter. Nothing here knows about a specific sandbox SDK: functions that
// need to run a command on the remote side take an injected `remoteExec`
// async function (command) => { exitCode, stdout, stderr } instead of a
// Daytona (or any other) SDK sandbox/client object.

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { shellQuote } from "./cli-shared.mjs";

function runTar(args, cwd) {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`.trim());
  return result;
}

function archiveOwnerArgs(owner) {
  if (!owner) return [];
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" });
  const versionText = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (/gnu tar/i.test(versionText)) {
    return ["--owner", String(owner.uid), "--group", String(owner.gid), "--numeric-owner"];
  }
  if (/bsdtar|libarchive/i.test(versionText)) {
    return ["--uid", String(owner.uid), "--gid", String(owner.gid), "--numeric-owner"];
  }
  const help = spawnSync("tar", ["--help"], { encoding: "utf8" });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  if (/--owner(?:[ =]|$)/.test(text) && /--group(?:[ =]|$)/.test(text)) {
    return ["--owner", String(owner.uid), "--group", String(owner.gid), "--numeric-owner"];
  }
  if (/--uid(?:[ =]|$)/.test(text) && /--gid(?:[ =]|$)/.test(text)) {
    return ["--uid", String(owner.uid), "--gid", String(owner.gid), "--numeric-owner"];
  }
  throw new Error("tar does not support explicit numeric archive ownership (--owner/--group or --uid/--gid)");
}

function listTarEntries(bundlePath) {
  const result = runTar(["-tzf", bundlePath], process.cwd());
  const entries = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const verbose = runTar(["-tvzf", bundlePath], process.cwd()).stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  for (const line of verbose) {
    const type = line[0];
    if (!["-", "d"].includes(type)) throw new Error(`Unsafe tar special entry rejected: ${line}`);
  }
  return validateTarEntries(entries);
}

function validateTarEntries(entries) {
  for (const entry of entries) {
    const rawName = typeof entry === "string" ? entry : entry?.name;
    if (!rawName) throw new Error(`Unsafe tar entry rejected: ${JSON.stringify(entry)}`);
    const normalized = String(rawName).replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || segments.includes("..")) {
      throw new Error(`Unsafe tar entry rejected: ${rawName}`);
    }
    if (typeof entry === "object" && entry.type && !["file", "regular", "directory", "dir", "-", "d"].includes(entry.type)) {
      throw new Error(`Unsafe tar special entry rejected: ${rawName} (${entry.type})`);
    }
  }
  return entries;
}

function createBundle(inputPath, taskId, options = {}) {
  const abs = path.resolve(inputPath);
  if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);
  const mode = options.mode ?? "bundle";
  const includeSensitive = Boolean(options.includeSensitive ?? options["include-sensitive"]);
  if (includeSensitive && mode !== "full") throw new Error("--include-sensitive is only valid with --mode full");
  if (!["bundle", "full"].includes(mode)) throw new Error(`Archive mode must be bundle or full (got ${mode})`);
  if (mode === "full" && !includeSensitive) throw new Error("--mode full may upload credentials; pass --include-sensitive to confirm");
  const resolvedAbs = (() => { try { return realpathSync(abs); } catch { return abs; } })();
  if ([abs, resolvedAbs].some((candidate) => candidate.split(path.sep).includes(".sandbox-ctl"))) {
    throw new Error(`Refusing to upload .sandbox-ctl control directory: ${abs}`);
  }
  if (mode === "bundle" && /^(\.env(?:\..*)?|\.git|node_modules|dist|build|\.claude|\.opencode-state|\.daytona|logs|.+\.log)$/.test(path.basename(abs))) {
    throw new Error(`Refusing sensitive path in bundle mode: ${abs}; use --mode full --include-sensitive`);
  }
  const tempTag = String(taskId ?? "bundle").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "bundle";
  const tempDir = mkdtempSync(path.join(tmpdir(), `daytona-input-${tempTag}-`));
  const bundlePath = path.join(tempDir, `daytona-input-${tempTag}.tar.gz`);
  try {
    const exclusions = mode === "full" ? [".sandbox-ctl"] : [".env*", ".git", ".sandbox-ctl", "node_modules", ".claude", ".opencode-state", ".daytona", "dist", "build", "*.log", "logs"];
    const tarArgs = ["-czf", bundlePath];
    tarArgs.push(...archiveOwnerArgs(options.archiveOwner));
    if (statSync(abs).isDirectory()) {
      for (const item of exclusions) tarArgs.push("--exclude", item);
      tarArgs.push("-C", abs, ".");
    } else {
      tarArgs.push("-C", path.dirname(abs), path.basename(abs));
    }
    runTar(tarArgs, process.cwd());
    listTarEntries(bundlePath);
    return { bundlePath, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function assertSafeRemoteTransferPath(remotePath) {
  const normalized = String(remotePath ?? "").replaceAll("\\", "/");
  if (!normalized) throw new Error("Remote path must not be empty");
  if (normalized.split("/").filter(Boolean).includes(".sandbox-ctl")) {
    throw new Error(`Refusing remote .sandbox-ctl control directory: ${remotePath}`);
  }
  return remotePath;
}

function remoteResultText(result) {
  const value = result?.stdout ?? result?.output ?? result?.result ?? result?.data ?? result?.artifacts?.stdout ?? result?.stderr;
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}

function stripRemoteShellWarnings(text) {
  return String(text).split(/\r?\n/).filter((line) => !/warning: setlocale:|cannot change locale/i.test(line)).join("\n");
}

function assertRemoteCommandSuccess(result, action = "remote command") {
  if (typeof result?.exitCode !== "number" || result.exitCode === 0) return result;
  const details = [];
  if (result.stderr) details.push(`stderr: ${String(result.stderr).trim()}`);
  if (result.stdout) details.push(`stdout: ${String(result.stdout).trim()}`);
  if (!details.length) details.push(`result: ${JSON.stringify(result)}`);
  throw new Error(`${action} failed with exit code ${result.exitCode}. ${details.join(" ")}`);
}

/** Resolve a remote path to its canonical absolute form via an injected remoteExec(command) transport. */
async function resolveRemoteTransferPath(remoteExec, remotePath) {
  assertSafeRemoteTransferPath(remotePath);
  const quoted = shellQuote(remotePath);
  const command = `if command -v realpath >/dev/null 2>&1; then realpath -- ${quoted}; elif command -v readlink >/dev/null 2>&1; then readlink -f -- ${quoted}; else echo 'remote realpath/readlink unavailable' >&2; exit 127; fi`;
  const result = await remoteExec(command);
  assertRemoteCommandSuccess(result, "remote path resolution");
  const output = stripRemoteShellWarnings(remoteResultText(result) ?? "");
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("/")) throw new Error(`Remote path resolution returned no absolute path: ${remotePath}`);
  assertSafeRemoteTransferPath(lines[0]);
  if (lines[0].split("/").includes("..")) throw new Error(`Unsafe resolved remote path rejected: ${lines[0]}`);
  return lines[0];
}

function assertNoSymlinkAncestors(target, stopAt) {
  let current = path.resolve(target);
  const boundary = path.resolve(stopAt);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlinked transfer path: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === boundary || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}

function prepareTransferOutput(outputPath, controlRoot, overwrite) {
  const output = path.resolve(outputPath);
  const relativeControl = path.relative(path.resolve(controlRoot), output);
  if (relativeControl === "" || (!relativeControl.startsWith("..") && !path.isAbsolute(relativeControl))) {
    throw new Error(`Refusing to extract into .sandbox-ctl control directory: ${output}`);
  }
  assertNoSymlinkAncestors(path.dirname(output), path.parse(output).root);
  if (existsSync(output)) {
    const info = lstatSync(output);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked transfer output: ${output}`);
    if (!info.isDirectory()) throw new Error(`Transfer output must be a directory: ${output}`);
    if (readdirSync(output).length && !overwrite) throw new Error(`Transfer output is not empty; pass --overwrite: ${output}`);
  } else {
    mkdirSync(output, { recursive: true });
  }
  return output;
}

function mergeTransferTree(source, destination, overwrite, relative = "") {
  for (const name of readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(destination, name);
    const rel = relative ? path.join(relative, name) : name;
    assertNoSymlinkAncestors(path.dirname(targetPath), destination);
    const sourceInfo = lstatSync(sourcePath);
    let targetInfo = null;
    try { targetInfo = lstatSync(targetPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (sourceInfo.isDirectory()) {
      if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())) throw new Error(`Refusing archive path type conflict: ${rel}`);
      if (!targetInfo) mkdirSync(targetPath);
      mergeTransferTree(sourcePath, targetPath, overwrite, rel);
    } else if (sourceInfo.isSymbolicLink()) {
      throw new Error(`Refusing special archive entry during merge: ${rel} (symlink)`);
    } else if (sourceInfo.isFile()) {
      if (targetInfo) {
        if (targetInfo.isDirectory() || targetInfo.isSymbolicLink() || !overwrite) throw new Error(`Refusing archive overwrite: ${rel}`);
      }
      copyFileSync(sourcePath, targetPath);
    } else throw new Error(`Refusing special archive entry during merge: ${rel}`);
  }
}

function assertNoControlArchiveEntries(entries) {
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry?.name;
    const segments = String(name ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
    if (segments.includes(".sandbox-ctl")) throw new Error(`Refusing archive entry in .sandbox-ctl control directory: ${name}`);
  }
}

export {
  assertNoControlArchiveEntries,
  assertRemoteCommandSuccess,
  assertSafeRemoteTransferPath,
  createBundle,
  listTarEntries,
  mergeTransferTree,
  prepareTransferOutput,
  remoteResultText,
  resolveRemoteTransferPath,
  runTar,
  stripRemoteShellWarnings,
  validateTarEntries,
};
