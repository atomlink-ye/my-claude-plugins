// Adapter-agnostic git bundle sync logic shared by every sandbox-ctl
// adapter. Every function here only touches the *local* git repository
// (creating/reading bundle files, managing local branches); the remote side
// is driven by each adapter's own remote-exec transport via an inline shell
// script built from `remoteEnsureGitCommand()` and friends, so nothing here
// needs an injected remoteExec function.

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function validateGitBranch(branch) {
  const value = String(branch ?? "").trim();
  if (!value || value.startsWith("-") || value.includes("..") || value.includes("\\") || value.includes("@{")) throw new Error(`Invalid git branch: ${value}`);
  const result = spawnSync("git", ["check-ref-format", "--branch", value], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Invalid git branch: ${value}`);
  return value;
}

function remoteEnsureGitCommand() {
  return "if ! command -v git >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then SUDO=''; if [ \"$(id -u)\" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; fi; $SUDO apt-get update && $SUDO apt-get install -y git; elif command -v apk >/dev/null 2>&1; then apk add --no-cache git; else echo 'git not found and no supported package manager available' >&2; exit 127; fi; fi";
}

function runLocal(command, args, cwd, action, env) {
  const result = spawnSync(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${action} failed: ${result.stderr || result.stdout}`.trim());
  return result;
}

function gitOutput(args, cwd, env) {
  return runLocal("git", args, cwd, `git ${args.join(" ")}`, env).stdout.trim();
}

function sensitiveGitPath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  return segments.some((segment) => segment.startsWith(".env") || segment.startsWith(".sandbox-ctl") || segment.startsWith(".claude") || segment.startsWith(".opencode-state") || segment.startsWith(".daytona")) || /(?:\.pem|\.key|\.p12|\.pfx|\.jks)$/i.test(basename) || /^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|credentials\.json)$/i.test(basename);
}

function gitStatusSummary(abs) {
  const result = spawnSync("git", ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"], { cwd: abs, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.stdout}`.trim());
  const summary = { staged: 0, unstaged: 0, untracked: 0, deleted: 0, renames: 0, submoduleDirty: 0, sparse: false };
  const paths = [];
  for (const line of String(result.stdout).split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("# ")) continue;
    const kind = line[0];
    if (kind === "?") { summary.untracked += 1; paths.push(line.slice(2)); continue; }
    if (kind === "2") { summary.renames += 1; const fields = line.split(" "); paths.push(fields.slice(9).join(" ")); continue; }
    if (kind === "1" || kind === "u") {
      const fields = line.split(" ");
      const xy = fields[1] ?? "  ";
      if (xy[0] !== "." && xy[0] !== " ") summary.staged += 1;
      if (xy[1] !== "." && xy[1] !== " ") summary.unstaged += 1;
      if (xy.includes("D")) summary.deleted += 1;
      paths.push(fields.slice(kind === "u" ? 10 : 8).join(" "));
    }
  }
  const sparse = spawnSync("git", ["config", "--bool", "core.sparseCheckout"], { cwd: abs, encoding: "utf8" });
  summary.sparse = sparse.status === 0 && sparse.stdout.trim() === "true";
  return { summary, paths };
}

function isGitSubmodule(abs, relativePath) {
  const mode = spawnSync("git", ["ls-files", "--stage", "--", relativePath], { cwd: abs, encoding: "utf8" });
  return mode.status === 0 && mode.stdout.split(/\r?\n/).some((line) => line.startsWith("160000 "));
}

function submoduleIsDirty(abs, relativePath) {
  if (!isGitSubmodule(abs, relativePath)) return false;
  const nested = path.join(abs, relativePath);
  if (!existsSync(nested) || !statSync(nested).isDirectory()) return false;
  const result = spawnSync("git", ["-C", nested, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function gitTempRef(prefix = "sync") { return `refs/sandbox-ctl-sync/${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

function createGitBundle(repoPath, taskId, options = {}) {
  const requested = path.resolve(repoPath);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new Error(`Git mode requires an existing local repository directory: ${requested}`);
  const abs = runLocal("git", ["rev-parse", "--show-toplevel"], requested, "git repository check").stdout.trim();
  const sourceHead = runLocal("git", ["rev-parse", "--verify", "HEAD"], abs, "git HEAD check").stdout.trim();
  const committedOnly = Boolean(options.committedOnly ?? options["committed-only"]);
  const requireClean = Boolean(options.requireClean ?? options["require-clean"]);
  if (committedOnly && requireClean) throw new Error("--committed-only and --require-clean are mutually exclusive");
  const { summary, paths: statusPaths } = gitStatusSummary(abs);
  const submodulePaths = String(spawnSync("git", ["ls-files", "--stage", "-z"], { cwd: abs, encoding: "utf8" }).stdout ?? "").split("\0").filter(Boolean).filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const dirtySubmodulePaths = [...statusPaths, ...submodulePaths].filter((entry) => submoduleIsDirty(abs, entry));
  for (const relativePath of statusPaths.filter((entry) => isGitSubmodule(abs, entry))) {
    const unstaged = spawnSync("git", ["diff", "--quiet", "--", relativePath], { cwd: abs });
    const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", relativePath], { cwd: abs });
    if (unstaged.status !== 0 || staged.status !== 0) dirtySubmodulePaths.push(relativePath);
  }
  summary.submoduleDirty = new Set(dirtySubmodulePaths).size;
  const dirty = summary.staged + summary.unstaged + summary.untracked + summary.deleted + summary.renames + summary.submoduleDirty > 0;
  if (requireClean && dirty) throw new Error("--require-clean rejected an uncommitted or dirty worktree");
  if (!committedOnly && summary.sparse) throw new Error("Git WIP push rejects sparse worktrees; use --committed-only");
  if (!committedOnly && summary.submoduleDirty) throw new Error("Git WIP push rejects dirty submodules; use --committed-only or clean the submodule");
  const tempDir = mkdtempSync(path.join(tmpdir(), "daytona-git-input-"));
  const bundlePath = path.join(tempDir, `daytona-git-input-${taskId}.bundle`);
  const indexPath = path.join(tempDir, "index");
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    runLocal("git", ["read-tree", sourceHead], abs, "temporary git index initialization", env);
    if (!committedOnly) runLocal("git", ["add", "--all", "--", "."], abs, "temporary git worktree snapshot", env);
    const finalPaths = String(spawnSync("git", ["ls-files", "-z"], { cwd: abs, env, encoding: "utf8" }).stdout ?? "").split("\0").filter(Boolean);
    if (!committedOnly) {
      for (const relativePath of finalPaths) {
        if (!sensitiveGitPath(relativePath)) continue;
        const existing = spawnSync("git", ["cat-file", "-e", `${sourceHead}:${relativePath}`], { cwd: abs, encoding: "utf8" });
        if (existing.status !== 0) throw new Error(`Sensitive newly-added path rejected: ${relativePath}`);
      }
    }
    const sourceTree = gitOutput(["rev-parse", `${sourceHead}^{tree}`], abs);
    const tree = committedOnly ? sourceTree : gitOutput(["write-tree"], abs, env);
    const includedWip = !committedOnly && tree !== sourceTree;
    let snapshotHead = sourceHead;
    if (includedWip) {
      const marker = `sandbox-ctl snapshot\nbranch=${options.branch ?? ""}\nbinding=${options.binding ?? ""}\nsource=${sourceHead}\n`;
      const commit = spawnSync("git", ["commit-tree", tree, "-p", sourceHead, "-F", "-"], { cwd: abs, env: { ...env, GIT_AUTHOR_NAME: "sandbox-ctl", GIT_AUTHOR_EMAIL: "sandbox-ctl@localhost", GIT_COMMITTER_NAME: "sandbox-ctl", GIT_COMMITTER_EMAIL: "sandbox-ctl@localhost" }, input: marker, encoding: "utf8" });
      if (commit.status !== 0) throw new Error(`git snapshot commit failed: ${commit.stderr || commit.stdout}`.trim());
      snapshotHead = commit.stdout.trim();
    }
    const snapshotRef = gitTempRef("input");
    runLocal("git", ["update-ref", snapshotRef, snapshotHead], abs, "temporary git snapshot ref", env);
    try { runLocal("git", ["bundle", "create", bundlePath, snapshotRef], abs, "git bundle create"); }
    finally { const removed = spawnSync("git", ["update-ref", "-d", snapshotRef], { cwd: abs, env: process.env, encoding: "utf8" }); if (removed.status !== 0) throw new Error(`Failed to clean temporary git snapshot ref ${snapshotRef}: ${removed.stderr || removed.stdout}`.trim()); }
    listGitBundle(bundlePath, abs);
    return { bundlePath, head: sourceHead, sourceHead, snapshotHead, includedWip, dirty, wipSummary: summary, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function listGitBundle(bundlePath, repoPath = process.cwd()) {
  const sourceRepo = path.resolve(repoPath);
  const result = spawnSync("git", ["-C", sourceRepo, "bundle", "verify", bundlePath], { cwd: sourceRepo, env: { ...process.env, GIT_DIR: path.join(sourceRepo, ".git") }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git bundle validation failed: ${result.stderr || result.stdout}`.trim());
  return result.stdout;
}

function localBranchCheckedOut(repoPath, branch) {
  const result = runLocal("git", ["worktree", "list", "--porcelain"], repoPath, "git worktree inspection");
  return result.stdout.split(/\r?\n/).some((line) => line.startsWith("branch refs/heads/") && line.slice(18).trim() === branch);
}

function fetchGitBundleIntoBranch(bundlePath, repoPath, branch) {
  const abs = path.resolve(repoPath);
  const safeBranch = validateGitBranch(branch);
  runLocal("git", ["rev-parse", "--show-toplevel"], abs, "git repository check");
  const tempRef = gitTempRef("remote");
  try {
    const bundleHead = spawnSync("git", ["bundle", "list-heads", bundlePath], { cwd: abs, encoding: "utf8" }).stdout.trim().split(/\s+/)[1];
    if (!bundleHead) throw new Error("git bundle has no advertised head");
    runLocal("git", ["fetch", bundlePath, `${bundleHead}:${tempRef}`], abs, "git fetch bundle");
    const remoteHead = runLocal("git", ["rev-parse", tempRef], abs, "git remote HEAD").stdout.trim();
    const target = `refs/heads/${safeBranch}`;
    const current = spawnSync("git", ["rev-parse", "--verify", target], { cwd: abs, encoding: "utf8" });
    if (current.status !== 0) { runLocal("git", ["update-ref", target, remoteHead, ""], abs, "git branch create"); return { branch: safeBranch, remoteHead, created: true }; }
    if (localBranchCheckedOut(abs, safeBranch)) throw new Error(`Refusing to update checked-out branch: ${safeBranch}`);
    const oldHead = current.stdout.trim();
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", oldHead, remoteHead], { cwd: abs, encoding: "utf8" });
    if (ancestor.status === 0) { runLocal("git", ["update-ref", target, remoteHead, oldHead], abs, "git fast-forward branch"); return { branch: safeBranch, remoteHead, fastForward: true }; }
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    let actual = `${safeBranch}-${timestamp}`;
    let suffix = 0;
    while (spawnSync("git", ["show-ref", "--verify", `refs/heads/${actual}`], { cwd: abs, encoding: "utf8" }).status === 0) actual = `${safeBranch}-${timestamp}-${++suffix}`;
    runLocal("git", ["update-ref", `refs/heads/${actual}`, remoteHead, ""], abs, "git divergence branch create");
    return { branch: actual, remoteHead, diverged: true };
  } finally {
    const cleanup = spawnSync("git", ["update-ref", "-d", tempRef], { cwd: abs, encoding: "utf8" });
    if (cleanup.status !== 0) throw new Error(`Failed to clean temporary git ref ${tempRef}: ${cleanup.stderr || cleanup.stdout}`.trim());
  }
}

export { createGitBundle, fetchGitBundleIntoBranch, listGitBundle, remoteEnsureGitCommand, runLocal, validateGitBranch };
