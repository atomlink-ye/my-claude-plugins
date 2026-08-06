import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { createGitBundle, fetchGitBundleIntoBranch, handlePull, handlePush, listGitBundle, main, parseArgs, validateGitBranch } from "../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs";
import { writeConfig, readConfig } from "../../../../skills/sandbox-ctl/scripts/project-config.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repo(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "fixture");
  git(directory, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(directory, "history.txt"), "one\n");
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "one");
  return directory;
}

function sandboxFixture(root, responses = {}) {
  const commands = [];
  const sandbox = {
    state: "started",
    process: { executeCommand: async (command) => {
      commands.push(command);
      if (command.includes("printf '%s") || command.includes("getent passwd") || command.includes("/etc/passwd")) return { exitCode: 0, stdout: "/home/test\n" };
      const response = responses.pull ?? responses.push ?? { exitCode: 0, stdout: "" };
      if (command.includes("SANDBOX_SNAPSHOT_HEAD") && response.exitCode === 0) return { ...response, stdout: "SANDBOX_SNAPSHOT_HEAD=0000000000000000000000000000000000000000\n" };
      return response;
    } },
    fs: { uploadFiles: async () => {}, downloadFile: async () => Buffer.from("") },
  };
  writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "/workspace/dev" } } });
  return { sandbox, commands, client: { get: async () => sandbox } };
}

function realSandboxFixture(root, remoteWorkspace = "workspace/dev", configDirectory = root) {
  const remoteHome = path.join(root, "remote-home");
  mkdirSync(path.join(remoteHome, "workspace"), { recursive: true });
  const commands = [];
  const runRemote = (command) => {
    commands.push(command);
    if (/printf/.test(command) || /getent passwd/.test(command) || /\/etc\/passwd/.test(command)) return { exitCode: 0, stdout: `${remoteHome}\n` };
    const result = spawnSync("sh", ["-lc", command], { encoding: "utf8" });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const sandbox = { state: "started", process: { executeCommand: async (command) => runRemote(command) }, fs: { uploadFiles: async ([item]) => copyFileSync(item.source, item.destination), downloadFile: async (remote, destination) => copyFileSync(remote, destination) } };
  writeConfig(configDirectory, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "s1", remoteWorkspace } } });
  return { sandbox, commands, client: { get: async () => sandbox }, remoteHome };
}

describe("non-destructive git sync", () => {
  it("captures the exact WIP tree and normalizes subdirectory invocation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-tree-"));
    try {
      const local = repo(root, "local"); mkdirSync(path.join(local, "nested"));
      writeFileSync(path.join(local, "delete-me.txt"), "delete\n"); git(local, "add", "."); git(local, "commit", "-qm", "second");
      spawnSync("git", ["rm", "-q", "delete-me.txt"], { cwd: local });
      writeFileSync(path.join(local, "nested", "new.txt"), "new\n");
      const snapshot = createGitBundle(path.join(local, "nested"), "tree", { branch: "sandbox-ctl/dev", binding: "dev" });
      try {
        expect(snapshot.includedWip).toBe(true);
        expect(git(local, "show", `${snapshot.snapshotHead}:nested/new.txt`)).toContain("new");
        expect(() => git(local, "show", `${snapshot.snapshotHead}:delete-me.txt`)).toThrow();
      } finally { snapshot.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects staged nested sensitive paths and preserves HEAD, branch, refs, index, stash, and status", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-state-"));
    try {
      const local = repo(root, "local"); const head = git(local, "rev-parse", "HEAD"); const branch = git(local, "branch", "--show-current");
      git(local, "stash", "push", "-qm", "empty"); const stash = git(local, "stash", "list");
      mkdirSync(path.join(local, "nested", ".claude"), { recursive: true }); writeFileSync(path.join(local, "nested", ".claude", "token.key"), "secret\n"); git(local, "add", ".");
      const index = git(local, "diff", "--cached", "--binary"); const status = git(local, "status", "--porcelain");
      expect(() => createGitBundle(local, "state")).toThrow(/nested\/\.claude|sensitive/i);
      expect(git(local, "rev-parse", "HEAD")).toBe(head); expect(git(local, "branch", "--show-current")).toBe(branch);
      expect(git(local, "diff", "--cached", "--binary")).toBe(index); expect(git(local, "status", "--porcelain")).toBe(status); expect(git(local, "stash", "list")).toBe(stash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects unrelated nonempty remote takeover and flags outside git push", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-guard-"));
    try {
      const local = repo(root, "local"); const fixture = realSandboxFixture(root, "workspace/dev", local); const remote = path.join(fixture.remoteHome, "workspace", "dev");
      mkdirSync(remote, { recursive: true }); git(remote, "init", "-q"); git(remote, "config", "user.name", "human"); git(remote, "config", "user.email", "human@example.invalid"); writeFileSync(path.join(remote, "human.txt"), "human\n"); git(remote, "add", "."); git(remote, "commit", "-qm", "human"); git(remote, "branch", "human"); git(remote, "checkout", "-q", "human");
      await expect(handlePush({ directory: local, path: local, mode: "git", client: fixture.client })).rejects.toThrow(/non-git|non-empty|foreign|dedicated branch/i);
      await expect(handlePush({ directory: local, path: local, mode: "bundle", committedOnly: true, client: fixture.client })).rejects.toThrow(/only valid|mode git/i);
      expect(parseArgs(["push", "--mode", "git", "--committed-only"]).options["committed-only"]).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects sparse WIP but preserves committed-only compatibility and matches sensitive case", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-sparse-"));
    try {
      const local = repo(root, "local");
      git(local, "sparse-checkout", "init", "--cone"); git(local, "sparse-checkout", "set", "missing");
      expect(() => createGitBundle(local, "sparse")).toThrow(/sparse/i);
      const committed = createGitBundle(local, "sparse-clean", { committedOnly: true }); committed.cleanup();
      git(local, "sparse-checkout", "disable");
      writeFileSync(path.join(local, "CERT.PEM"), "secret\n");
      expect(() => createGitBundle(local, "upper-sensitive")).toThrow(/CERT\.PEM/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects WIP flags on unrelated top-level commands", async () => {
    await expect(main(["status", "--committed-only"])).rejects.toThrow(/only valid with push/i);
    await expect(main(["down", "--require-clean"])).rejects.toThrow(/only valid with push/i);
  });

  it("rejects dirty tracked and untracked submodule WIP while committed-only sends HEAD", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-submodule-"));
    try {
      const child = repo(root, "child"); const local = repo(root, "local");
      spawnSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child"], { cwd: local });
      git(local, "commit", "-qm", "add submodule");
      expect(git(local, "ls-files", "--stage")).toMatch(/160000/);
      writeFileSync(path.join(local, "child", "tracked.txt"), "tracked\n"); writeFileSync(path.join(local, "child", "untracked.txt"), "untracked\n");
      expect(() => createGitBundle(local, "dirty-submodule")).toThrow(/dirty submodule/i);
      const committed = createGitBundle(local, "dirty-submodule-head", { committedOnly: true });
      try { expect(committed.includedWip).toBe(false); expect(committed.snapshotHead).toBe(committed.sourceHead); } finally { committed.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("snapshots tracked, staged, deleted, renamed, and untracked WIP without changing the real index", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-"));
    try {
      const local = repo(root, "local");
      writeFileSync(path.join(local, "rename.txt"), "rename\n"); git(local, "add", "rename.txt"); git(local, "commit", "-qm", "rename source");
      writeFileSync(path.join(local, "staged.txt"), "staged\n"); git(local, "add", "staged.txt");
      writeFileSync(path.join(local, "history.txt"), "one\nunstaged\n");
      git(local, "mv", "rename.txt", "renamed.txt");
      writeFileSync(path.join(local, "untracked.txt"), "untracked\n");
      git(local, "rm", "--cached", "staged.txt");
      const indexBefore = git(local, "diff", "--cached", "--binary");
      const bundle = createGitBundle(local, "wip");
      try {
        expect(bundle.includedWip).toBe(true);
        expect(bundle.snapshotHead).not.toBe(bundle.sourceHead);
        expect(bundle.wipSummary.untracked).toBe(2);
        expect(bundle.wipSummary.renames).toBeGreaterThan(0);
        expect(git(local, "diff", "--cached", "--binary")).toBe(indexBefore);
        expect(git(local, "status", "--porcelain")).toMatch(/staged|renamed|untracked/);
        expect(readFileSync(path.join(local, "history.txt"), "utf8")).toBe("one\nunstaged\n");
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("supports committed-only and require-clean flags and rejects their combination", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-flags-"));
    try {
      const local = repo(root, "local"); writeFileSync(path.join(local, "wip.txt"), "wip\n");
      const committed = createGitBundle(local, "committed", { committedOnly: true });
      try { expect(committed.includedWip).toBe(false); expect(committed.snapshotHead).toBe(committed.sourceHead); } finally { committed.cleanup(); }
      expect(() => createGitBundle(local, "clean", { requireClean: true })).toThrow(/require-clean|uncommitted/i);
      expect(() => createGitBundle(local, "both", { committedOnly: true, requireClean: true })).toThrow(/mutually exclusive/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not claim WIP was included for dirty committed-only pushes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-committed-warning-"));
    try {
      const local = repo(root, "local"); writeFileSync(path.join(local, "draft.txt"), "draft\n"); const fixture = realSandboxFixture(root, "workspace/dev", local);
      const result = await handlePush({ directory: local, path: local, mode: "git", committedOnly: true, client: fixture.client });
      expect(result.includedWip).toBe(false); expect(result.warnings.join(" ")).not.toMatch(/WIP snapshot included/i); expect(result.warnings.join(" ")).toMatch(/excluded|HEAD only|committed/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("repeats WIP pushes safely and can transition back to committed-only", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-repeat-"));
    try {
      const local = repo(root, "local"); const fixture = realSandboxFixture(root, "workspace/dev", local);
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      writeFileSync(path.join(local, "history.txt"), "one\nwip\n"); writeFileSync(path.join(local, "draft.txt"), "draft one\n");
      const first = await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      expect(first.includedWip).toBe(true);
      const remote = path.join(fixture.remoteHome, "workspace", "dev");
      expect(readFileSync(path.join(remote, "draft.txt"), "utf8")).toBe("draft one\n");
      writeFileSync(path.join(local, "draft.txt"), "draft two\n");
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      expect(readFileSync(path.join(remote, "draft.txt"), "utf8")).toBe("draft two\n");
      const committed = await handlePush({ directory: local, path: local, mode: "git", committedOnly: true, client: fixture.client });
      expect(committed.includedWip).toBe(false);
      expect(existsSync(path.join(remote, "draft.txt"))).toBe(false);
      expect(git(remote, "status", "--porcelain")).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects sensitive nonignored untracked WIP while excluding ignored files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-wip-sensitive-"));
    try {
      const local = repo(root, "local"); writeFileSync(path.join(local, ".gitignore"), "ignored.txt\n"); git(local, "add", ".gitignore"); git(local, "commit", "-qm", "ignore");
      writeFileSync(path.join(local, "ignored.txt"), "ignored\n"); writeFileSync(path.join(local, ".env.secret"), "secret\n");
      expect(() => createGitBundle(local, "sensitive")).toThrow(/\.env\.secret/);
      const committed = createGitBundle(local, "ignored", { committedOnly: true });
      committed.cleanup();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts the sandbox-ctl branch namespace and rejects option injection", () => {
    expect(validateGitBranch("sandbox-ctl/dev")).toBe("sandbox-ctl/dev");
    expect(() => validateGitBranch("--force")).toThrow(/invalid/i);
    expect(() => validateGitBranch("sandbox-ctl/../escape")).toThrow(/invalid/i);
  });

  it("rejects an invalid repository without leaving git bundle temp directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-invalid-"));
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("daytona-git-input-"));
    try { expect(() => createGitBundle(root, "invalid")).toThrow(/git|repository/i); }
    finally {
      expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("daytona-git-input-"))).toEqual(before);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies bundles relative to their source repository, not process cwd", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-cwd-"));
    try {
      const source = repo(root, "source");
      const bundle = createGitBundle(source, "cwd");
      try {
        expect(() => listGitBundle(bundle.bundlePath, source)).not.toThrow();
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("creates and verifies a bundle from a child process whose cwd is not a Git repo", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-child-cwd-"));
    try {
      const source = repo(root, "source");
      const nonGitCwd = path.join(root, "not-a-repo"); mkdirSync(nonGitCwd);
      const moduleUrl = new URL("../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs", import.meta.url).href;
      const script = `import { createGitBundle } from ${JSON.stringify(moduleUrl)}; const bundle = createGitBundle(process.argv.at(-1), "child"); console.log(bundle.bundlePath); bundle.cleanup();`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, source], { cwd: nonGitCwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/daytona-git-input-/);
      expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("daytona-git-input-")).length).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports dirty local files while bundling committed history only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const local = repo(root, "local");
      writeFileSync(path.join(local, "uncommitted.txt"), "not committed\n");
      const bundle = createGitBundle(local, "fixture");
      try {
        expect(bundle.dirty).toBe(true);
        expect(bundle.head).toBe(git(local, "rev-parse", "HEAD"));
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("creates a dedicated branch from a remote bundle without checking it out", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const source = repo(root, "source");
      const target = repo(root, "target");
      writeFileSync(path.join(source, "history.txt"), "one\ntwo\n");
      git(source, "add", "."); git(source, "commit", "-qm", "two");
      const bundle = createGitBundle(source, "fixture");
      try {
        const received = fetchGitBundleIntoBranch(bundle.bundlePath, target, "sandbox-ctl/dev");
        expect(received.branch).toBe("sandbox-ctl/dev");
        expect(git(target, "branch", "--show-current")).not.toBe("sandbox-ctl/dev");
        expect(git(target, "show", "sandbox-ctl/dev:history.txt")).toContain("one");
        expect(Number(git(target, "rev-list", "--count", "sandbox-ctl/dev"))).toBe(2);
        expect(git(target, "for-each-ref", "--format=%(refname)", "refs/sandbox-ctl-sync")).toBe("");
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fast-forwards an existing un-checked-out target atomically", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const source = repo(root, "source");
      const target = repo(root, "target");
      const first = createGitBundle(source, "fixture");
      try { fetchGitBundleIntoBranch(first.bundlePath, target, "sandbox-ctl/dev"); } finally { first.cleanup(); }
      writeFileSync(path.join(source, "history.txt"), "two\n");
      git(source, "add", "."); git(source, "commit", "-qm", "two");
      const second = createGitBundle(source, "fixture");
      try {
        const received = fetchGitBundleIntoBranch(second.bundlePath, target, "sandbox-ctl/dev");
        expect(received.fastForward).toBe(true);
        expect(git(target, "show", "sandbox-ctl/dev:history.txt")).toContain("two");
      } finally { second.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a checked-out target and preserves it on divergence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const source = repo(root, "source");
      const target = repo(root, "target");
      const first = createGitBundle(source, "fixture");
      try { fetchGitBundleIntoBranch(first.bundlePath, target, "sandbox-ctl/dev"); } finally { first.cleanup(); }
      git(target, "checkout", "-q", "sandbox-ctl/dev");
      const checked = createGitBundle(source, "fixture");
      try { expect(() => fetchGitBundleIntoBranch(checked.bundlePath, target, "sandbox-ctl/dev")).toThrow(/checked-out/i); } finally { checked.cleanup(); }
      git(target, "checkout", "-q", "main");
      git(target, "checkout", "-q", "sandbox-ctl/dev");
      writeFileSync(path.join(target, "target-only.txt"), "target\n"); git(target, "add", "."); git(target, "commit", "-qm", "target diverged");
      git(target, "checkout", "-q", "main");
      writeFileSync(path.join(source, "history.txt"), "diverged\n"); git(source, "add", "."); git(source, "commit", "-qm", "diverged");
      const divergent = createGitBundle(source, "fixture");
      try {
        const received = fetchGitBundleIntoBranch(divergent.bundlePath, target, "sandbox-ctl/dev");
        expect(received.diverged).toBe(true);
        expect(received.branch).toMatch(/^sandbox-ctl\/dev-\d{8}T\d{6}Z/);
        expect(git(target, "rev-parse", "sandbox-ctl/dev")).not.toBe(received.remoteHead);
      } finally { divergent.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("warns on dirty local push and records transactional binding sync", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const local = repo(root, "local"); writeFileSync(path.join(local, "dirty.txt"), "dirty\n");
      const fixture = sandboxFixture(root); const result = await handlePush({ directory: root, path: local, mode: "git", client: fixture.client });
      expect(result.warnings[0]).toMatch(/uncommitted|committed history/i);
      expect(readConfig(root).sandboxes.dev.sync).toEqual({ mode: "git", branch: "sandbox-ctl/dev" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for non-git and ahead remote workspaces without destructive commands", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const local = repo(root, "local");
      for (const [code, message] of [[73, "non-git and non-empty"], [74, "remote git workspace is dirty"], [75, "remote git workspace diverged; pull first"]]) {
        const fixture = sandboxFixture(root, { push: { exitCode: code, stderr: message } });
        await expect(handlePush({ directory: root, path: local, mode: "git", client: fixture.client })).rejects.toThrow(/git|pull|ahead/i);
        const sync = fixture.commands.at(-1);
        expect(sync).not.toContain("rm -rf");
        expect(sync).not.toContain("--force");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects dirty remote pull without auto-commit and gives an actionable status command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-sync-"));
    try {
      const fixture = sandboxFixture(root, { pull: { exitCode: 74, stderr: "dirty; run sandbox-ctl exec -- git status" } });
      await expect(handlePull({ directory: root, mode: "git", client: fixture.client })).rejects.toThrow(/dirty|status|commit/i);
      const command = fixture.commands.at(-1);
      expect(command).not.toMatch(/git\s+add|git\s+commit/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("pushes a real remote workspace from A to B without replacing it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-real-"));
    try {
      const local = repo(root, "local");
      const fixture = realSandboxFixture(root, "workspace/dev", local);
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      const remote = path.join(fixture.remoteHome, "workspace", "dev");
      expect(readFileSync(path.join(remote, "history.txt"), "utf8")).toBe("one\n");
      writeFileSync(path.join(local, "history.txt"), "one\ntwo\n"); git(local, "add", "."); git(local, "commit", "-qm", "two");
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      expect(git(remote, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "HEAD"));
      expect(readFileSync(path.join(remote, "history.txt"), "utf8")).toBe("one\ntwo\n");
      expect(git(remote, "branch", "--show-current")).toBe("sandbox-ctl/dev");
      expect(fixture.commands.filter((command) => command.includes("git -C")).length).toBeGreaterThanOrEqual(2);
      expect(fixture.commands.some((command) => command.includes("rm -f \"$remote_bundle\""))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not evaluate shell metacharacters in remote workspace paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-shell-"));
    const sentinel = path.join(root, "sentinel");
    const malicious = `workspace/space $(touch ${sentinel}) \`touch ${sentinel}.backtick\``;
    try {
      const local = repo(root, "local");
      const fixture = realSandboxFixture(root, malicious, local);
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(`${sentinel}.backtick`)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the requested binding branch after pull divergence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-git-pull-diverge-"));
    try {
      const local = repo(root, "local");
      const fixture = realSandboxFixture(root, "workspace/dev", local);
      await handlePush({ directory: local, path: local, mode: "git", client: fixture.client });
      await handlePull({ directory: local, mode: "git", client: fixture.client });
      git(local, "checkout", "-q", "sandbox-ctl/dev");
      writeFileSync(path.join(local, "local-only.txt"), "local\n"); git(local, "add", "."); git(local, "commit", "-qm", "local divergence");
      git(local, "checkout", "-q", "main");
      const remote = path.join(fixture.remoteHome, "workspace", "dev");
      writeFileSync(path.join(remote, "remote-only.txt"), "remote\n"); git(remote, "add", "."); git(remote, "commit", "-qm", "remote divergence");
      const result = await handlePull({ directory: local, mode: "git", client: fixture.client });
      expect(result.diverged).toBe(true);
      expect(result.branch).not.toBe("sandbox-ctl/dev");
      expect(readConfig(local).sandboxes.dev.sync.branch).toBe("sandbox-ctl/dev");
      expect(fixture.commands.some((command) => command.includes("rm -f '/tmp/daytona-git-output-local.bundle'"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
