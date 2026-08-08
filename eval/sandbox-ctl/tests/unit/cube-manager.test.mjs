import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  assertManagedSandboxInfo,
  createClient,
  cubeExec,
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
  requireSandbox,
  resolveProjectPaths,
  runDoctorCheck,
  toRemoteAbsolute,
} from "../../../../skills/sandbox-ctl/scripts/adapters/cube-manager.mjs";
import { readConfig, writeConfig } from "../../../../skills/sandbox-ctl/scripts/project-config.mjs";

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

/**
 * Build a fake Cube "sandbox" object shaped like a real, connected `e2b`
 * `Sandbox` instance: `.commands.run(cmd, opts)`, `.files.write/read/getInfo`,
 * `.getHost(port)`. `commandHandler(cmd)` decides the (possibly non-zero-exit)
 * response for a given shell command; a non-zero response is *thrown*
 * (duck-typed `{ exitCode, stdout, stderr }`) to mirror the real SDK's
 * `commands.run(cmd, { background: false })` behavior confirmed by reading
 * node_modules/e2b/dist/index.js (`CommandHandle.wait()` throws
 * `CommandExitError` on non-zero exit).
 */
function fakeSandbox({ sandboxId = "sbx-1", commandHandler, files = {}, host } = {}) {
  const commands = [];
  const written = {};
  return {
    sandboxId,
    commands: {
      run: async (cmd, opts = {}) => {
        commands.push(cmd);
        const response = commandHandler ? commandHandler(cmd) : { exitCode: 0, stdout: "/home/user\n", stderr: "" };
        if (opts.onStdout && response.stdout) opts.onStdout(response.stdout);
        if (opts.onStderr && response.stderr) opts.onStderr(response.stderr);
        if (response.exitCode && response.exitCode !== 0) {
          throw { exitCode: response.exitCode, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
        }
        return { exitCode: response.exitCode ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
      },
    },
    files: {
      write: async (remotePath, data) => { written[remotePath] = data; return { path: remotePath }; },
      read: async (remotePath) => files[remotePath] ?? Buffer.from(""),
      getInfo: async (remotePath) => {
        if (files[remotePath] !== undefined) return { type: "file", path: remotePath, name: path.posix.basename(remotePath) };
        return { type: "dir", path: remotePath, name: path.posix.basename(remotePath) };
      },
    },
    getHost: (port) => (host ? host(port) : `${port}-${sandboxId}.cube.app`),
    kill: async () => true,
    _commands: commands,
    _written: written,
  };
}

function bindConfig(root, overrides = {}) {
  writeConfig(root, { schemaVersion: 1, adapter: "cube", active: "dev", sandboxes: { dev: { sandboxId: "sbx-1", remoteWorkspace: "workspace/dev", ...overrides } } });
}

describe("cube-manager argument parsing", () => {
  it("parses transfer mode flags", () => {
    expect(parseArgs(["push", "--mode", "full", "--include-sensitive"]).options).toMatchObject({ mode: "full", "include-sensitive": true });
    expect(parseArgs(["pull", "--mode", "git", "--branch", "sandbox-ctl/dev"]).options).toMatchObject({ mode: "git", branch: "sandbox-ctl/dev" });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["up", "--unknown-flag"])).toThrow(/unknown option/i);
  });

  it("parsePort rejects out-of-range and non-integer ports", () => {
    expect(() => parsePort("0")).toThrow(/invalid port/i);
    expect(() => parsePort("70000")).toThrow(/invalid port/i);
    expect(() => parsePort("abc")).toThrow(/invalid port/i);
    expect(parsePort("8080")).toBe(8080);
  });
});

describe("cube-manager remote path helpers", () => {
  it("requires a remote home for relative remote paths", () => {
    expect(() => toRemoteAbsolute("relative/path")).toThrow(/remote home/i);
    expect(toRemoteAbsolute("/workspace/x")).toBe("/workspace/x");
    expect(toRemoteAbsolute("relative/path", "/home/user")).toBe("/home/user/relative/path");
  });

  it("rejects path traversal", () => {
    expect(() => toRemoteAbsolute("/workspace/../etc/passwd")).toThrow(/unsafe/i);
  });
});

describe("cubeExec duck-typed exit handling", () => {
  it("returns a normalized result on success", async () => {
    const sandbox = fakeSandbox({ commandHandler: () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }) });
    await expect(cubeExec(sandbox, "true")).resolves.toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  it("captures a thrown CommandExitError-shaped error as a normal non-zero result instead of rejecting", async () => {
    const sandbox = fakeSandbox({ commandHandler: () => ({ exitCode: 7, stdout: "partial\n", stderr: "boom\n" }) });
    await expect(cubeExec(sandbox, "false")).resolves.toEqual({ exitCode: 7, stdout: "partial\n", stderr: "boom\n" });
  });

  it("rethrows genuine transport failures that don't look like a CommandResult", async () => {
    const sandbox = { commands: { run: async () => { throw new Error("connection reset"); } } };
    await expect(cubeExec(sandbox, "true")).rejects.toThrow(/connection reset/);
  });
});

describe("cube-manager sandbox lookups", () => {
  it("isNotFoundError recognizes e2b's SandboxNotFoundError/.name shape", () => {
    expect(isNotFoundError({ name: "SandboxNotFoundError", message: "Sandbox x not found" })).toBe(true);
    expect(isNotFoundError({ name: "FileNotFoundError" })).toBe(true);
    expect(isNotFoundError(new Error("boom"))).toBe(false);
    expect(isNotFoundError({ message: "sandbox not found" })).toBe(true);
  });

  it("requireSandbox throws a clear error when there is no binding", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-no-binding-"));
    try {
      await expect(requireSandbox({ directory: root })).rejects.toThrow(/no cube sandbox binding/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager exec", () => {
  it("streams stdout/stderr and preserves a non-zero remote exit code", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-exec-"));
    const oldOut = process.stdout.write;
    const oldErr = process.stderr.write;
    const stdout = [];
    const stderr = [];
    try {
      bindConfig(root);
      const sandbox = fakeSandbox({ commandHandler: (cmd) => {
        if (cmd.includes("HOME:-") || cmd.includes("getent passwd") || cmd.includes("/etc/passwd")) return { exitCode: 0, stdout: "/home/user\n" };
        return { exitCode: 7, stdout: "out-1\n", stderr: "err-1\n" };
      } });
      const client = { connect: async () => sandbox };
      process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
      process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
      const result = await handleExec({ directory: root, client }, ["sh", "-lc", "printf out-1; printf err-1 1>&2; exit 7"]);
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("out-1\n");
      expect(result.stderr).toBe("err-1\n");
      expect(stdout.join("")).toBe("out-1\n");
      expect(stderr.join("")).toBe("err-1\n");
    } finally {
      process.stdout.write = oldOut;
      process.stderr.write = oldErr;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns exit code 125 with a redacted message on transport failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-exec-fail-"));
    try {
      bindConfig(root);
      process.env.CUBE_TEST_TOKEN = "supersecretvalue";
      const client = { connect: async () => { throw new Error(`auth failed with token supersecretvalue`); } };
      const result = await handleExec({ directory: root, client }, ["true"]);
      expect(result.exitCode).toBe(125);
      expect(result.error).not.toContain("supersecretvalue");
      expect(result.error).toContain("[redacted]");
    } finally { delete process.env.CUBE_TEST_TOKEN; rmSync(root, { recursive: true, force: true }); }
  });

  it("requires a command after --", async () => {
    await expect(handleExec({}, [])).rejects.toThrow(/requires a command/i);
  });
});

describe("cube-manager push/pull mode validation", () => {
  it("rejects unknown modes", async () => {
    await expect(handlePush({ directory: mkdtempSync(path.join(tmpdir(), "cube-push-mode-")), mode: "bogus" })).rejects.toThrow(/mode must be bundle, full, or git/i);
    await expect(handlePull({ directory: mkdtempSync(path.join(tmpdir(), "cube-pull-mode-")), mode: "bogus" })).rejects.toThrow(/mode must be bundle, full, or git/i);
  });

  it("rejects --committed-only/--require-clean outside git mode", async () => {
    await expect(handlePush({ directory: mkdtempSync(path.join(tmpdir(), "cube-push-committed-")), mode: "bundle", "committed-only": true })).rejects.toThrow(/only valid with push --mode git/i);
  });

  it("requires --include-sensitive for full mode and rejects it elsewhere", async () => {
    await expect(handlePush({ directory: mkdtempSync(path.join(tmpdir(), "cube-push-full-")), mode: "full" })).rejects.toThrow(/include-sensitive/i);
    await expect(handlePush({ directory: mkdtempSync(path.join(tmpdir(), "cube-push-bundle-sensitive-")), mode: "bundle", "include-sensitive": true })).rejects.toThrow(/only valid with --mode full/i);
  });
});

describe("cube-manager single-file fast path", () => {
  it("push auto-detects a non-directory local path and uploads via files.write without tar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-push-file-"));
    try {
      bindConfig(root);
      const filePath = path.join(root, "note.txt");
      writeFileSync(filePath, "hello cube\n");
      const sandbox = fakeSandbox({ commandHandler: (cmd) => ({ exitCode: 0, stdout: cmd.includes("printf") || cmd.includes("passwd") ? "/home/user\n" : "" }) });
      const client = { connect: async () => sandbox };
      const result = await handlePush({ directory: root, path: filePath, "remote-path": "workspace/dev", client });
      expect(result).toMatchObject({ ok: true, mode: "file" });
      expect(result.remoteWorkspace).toBe("/home/user/workspace/dev/note.txt");
      expect(Buffer.from(sandbox._written[result.remoteWorkspace]).toString()).toBe("hello cube\n");
      // No tar archive command should have been run for a single-file transfer.
      expect(sandbox._commands.some((cmd) => cmd.includes("tar -czf") || cmd.includes("tar -xzf"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("pull auto-detects a non-directory remote path via files.getInfo and downloads without tar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-pull-file-"));
    try {
      bindConfig(root);
      const remoteHome = "/home/user";
      const remoteFile = `${remoteHome}/workspace/dev/result.txt`;
      const sandbox = fakeSandbox({
        commandHandler: (cmd) => {
          if (cmd.includes("printf") || cmd.includes("passwd")) return { exitCode: 0, stdout: `${remoteHome}\n` };
          if (cmd.includes("realpath") || cmd.includes("readlink")) return { exitCode: 0, stdout: `${remoteFile}\n` };
          return { exitCode: 0, stdout: "" };
        },
        files: { [remoteFile]: Buffer.from("remote contents\n") },
      });
      const client = { connect: async () => sandbox };
      const output = path.join(root, "out");
      const result = await handlePull({ directory: root, output, "remote-path": remoteFile, client });
      expect(result).toMatchObject({ ok: true, mode: "file" });
      expect(readFileSync(path.join(output, "result.txt"), "utf8")).toBe("remote contents\n");
      expect(sandbox._commands.some((cmd) => cmd.includes("tar -czf"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a sensitive single-file basename outside full+include-sensitive", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-push-sensitive-file-"));
    try {
      bindConfig(root);
      const filePath = path.join(root, ".env");
      writeFileSync(filePath, "SECRET=1\n");
      const sandbox = fakeSandbox({ commandHandler: () => ({ exitCode: 0, stdout: "/home/user\n" }) });
      const client = { connect: async () => sandbox };
      await expect(handlePush({ directory: root, path: filePath, client })).rejects.toThrow(/sensitive/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager git push shell script construction", () => {
  it("builds a fast-forward-only remote script and returns the parsed snapshot head without executing real git remotely", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-git-push-"));
    try {
      const local = repo(root, "local");
      bindConfig(root);
      const sandbox = fakeSandbox({ commandHandler: (cmd) => {
        if (cmd.includes("printf") || cmd.includes("passwd")) return { exitCode: 0, stdout: "/home/user\n" };
        if (cmd.includes("SANDBOX_SNAPSHOT_HEAD")) return { exitCode: 0, stdout: "SANDBOX_SNAPSHOT_HEAD=0000000000000000000000000000000000000000\n" };
        return { exitCode: 0, stdout: "" };
      } });
      const client = { connect: async () => sandbox };
      const result = await handlePush({ directory: root, path: local, mode: "git", branch: "sandbox-ctl/dev", client });
      expect(result).toMatchObject({ ok: true, mode: "git", branch: "sandbox-ctl/dev", snapshotHead: "0000000000000000000000000000000000000000" });
      const gitScript = sandbox._commands.find((cmd) => cmd.includes("SANDBOX_SNAPSHOT_HEAD"));
      expect(gitScript).toBeTruthy();
      expect(gitScript).toContain("git -C \"$target\" merge --ff-only");
      expect(gitScript).toContain("remote git workspace is dirty; commit or clean it before push");
      expect(gitScript).toContain("remote git workspace contains a foreign or unrelated commit; refusing push");
      expect(gitScript).toContain("'sandbox-ctl/dev'");
      const config = readConfig(root);
      expect(config.sandboxes.dev.sync).toEqual({ mode: "git", branch: "sandbox-ctl/dev" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("builds a dirty-workspace-refusing pull bundling command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-git-pull-"));
    try {
      bindConfig(root);
      const sandbox = fakeSandbox({ commandHandler: (cmd) => {
        if (cmd.includes("printf") || cmd.includes("passwd")) return { exitCode: 0, stdout: "/home/user\n" };
        return { exitCode: 73, stdout: "", stderr: "remote workspace is not a git repository" };
      } });
      const client = { connect: async () => sandbox };
      await expect(handlePull({ directory: root, mode: "git", client })).rejects.toThrow(/git pull sync bundling failed/i);
      const gitScript = sandbox._commands.find((cmd) => cmd.includes("bundle create"));
      expect(gitScript).toContain("remote workspace is not a git repository");
      expect(gitScript).toContain("remote git workspace is dirty; commit changes before pull");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager preview", () => {
  it("requires --port and rejects --expires-in", async () => {
    await expect(handlePreview({ directory: mkdtempSync(path.join(tmpdir(), "cube-preview-noport-")) })).rejects.toThrow(/requires --port/i);
    const root = mkdtempSync(path.join(tmpdir(), "cube-preview-expires-"));
    try {
      bindConfig(root);
      await expect(handlePreview({ directory: root, port: "8080", "expires-in": "60", client: { connect: async () => fakeSandbox() } })).rejects.toThrow(/expires-in.*not supported/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns the sandbox getHost(port)-derived https URL", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-preview-"));
    try {
      bindConfig(root);
      const sandbox = fakeSandbox({ sandboxId: "abc123", host: (port) => `${port}-abc123.cube.app` });
      const client = { connect: async () => sandbox };
      const result = await handlePreview({ directory: root, port: "8080", client });
      expect(result).toEqual({ port: 8080, url: "https://8080-abc123.cube.app" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager down", () => {
  it("refuses to kill without a binding", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-down-nobinding-"));
    try {
      await expect(handleDown({ directory: root })).rejects.toThrow(/no cube sandbox binding/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("kills the exact bound sandboxId and removes the binding", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-down-"));
    try {
      bindConfig(root);
      const killed = [];
      const client = { getInfo: async (id) => ({ metadata: { "sandbox-ctl.managed": "true" } }), kill: async (id) => { killed.push(id); return true; } };
      const result = await handleDown({ directory: root, client });
      expect(killed).toEqual(["sbx-1"]);
      expect(result).toMatchObject({ sandboxId: "sbx-1", killed: true, stateKept: false });
      expect(readConfig(root).sandboxes.dev).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the binding when --keep-state is passed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-down-keep-"));
    try {
      bindConfig(root);
      const client = { getInfo: async () => ({ metadata: {} }), kill: async () => true };
      await handleDown({ directory: root, client, "keep-state": true });
      expect(readConfig(root).sandboxes.dev).toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("assertManagedSandboxInfo refuses an unmanaged or foreign-project sandbox when requested", async () => {
    expect(() => assertManagedSandboxInfo({ metadata: {} })).toThrow(/unmanaged/i);
    expect(() => assertManagedSandboxInfo({ metadata: { "sandbox-ctl.managed": "true", "sandbox-ctl.project": "other" } }, "mine")).toThrow(/project identity mismatch/i);
    expect(() => assertManagedSandboxInfo({ metadata: { "sandbox-ctl.managed": "true", "sandbox-ctl.project": "mine" } }, "mine")).not.toThrow();
  });

  it("enforces the managed-policy check when requireManagedPolicy is set", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-down-policy-"));
    try {
      bindConfig(root);
      const client = { getInfo: async () => ({ metadata: {} }), kill: async () => { throw new Error("should not be called"); } };
      await expect(handleDown({ directory: root, client, requireManagedPolicy: true })).rejects.toThrow(/unmanaged/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager list/doctor", () => {
  it("paginates through Sandbox.list()'s SandboxPaginator shape", async () => {
    const pages = [[{ sandboxId: "a", name: "one", state: "running", templateId: "base" }], [{ sandboxId: "b", name: "two", state: "paused", templateId: "base" }]];
    const client = { list: () => {
      let hasNext = true;
      return {
        get hasNext() { return hasNext; },
        nextItems: async () => { const page = pages.shift(); hasNext = pages.length > 0; return page ?? []; },
      };
    } };
    const result = await handleList({ client });
    expect(result.sandboxes).toEqual([
      { id: "a", name: "one", state: "running", template: "base" },
      { id: "b", name: "two", state: "paused", template: "base" },
    ]);
  });

  it("runDoctorCheck reports missing configuration without throwing", async () => {
    const result = await runDoctorCheck({ createClient: async () => { throw new Error("Cube API key is required. Set CUBE_API_KEY or E2B_API_KEY."); }, env: {} });
    expect(result).toMatchObject({ apiKeyConfigured: false, apiUrlConfigured: false, connected: false, category: "connection_error" });
    expect(result.error).toMatch(/api key is required/i);
  });

  it("runDoctorCheck reports connected:true when the client lists successfully", async () => {
    const client = { list: () => ({ hasNext: true, nextItems: async () => [] }) };
    const result = await runDoctorCheck({ createClient: async () => client, env: { CUBE_API_KEY: "k", CUBE_API_URL: "http://127.0.0.1:3000" } });
    expect(result).toMatchObject({ apiKeyConfigured: true, apiUrlConfigured: true, connected: true, category: "ok" });
  });

  it("handleDoctor never throws and always prints JSON", async () => {
    const originalLog = console.log;
    const logs = [];
    try {
      console.log = (...args) => logs.push(args.join(" "));
      const result = await handleDoctor({});
      expect(result.ok).toBe(false);
      expect(logs.join(" ")).toContain('"connected": false');
    } finally { console.log = originalLog; }
  });
});

describe("cube-manager createClient env resolution", () => {
  it("requires an API key and URL, bridging CUBE_* into E2B_*", async () => {
    const savedEnv = { ...process.env };
    try {
      delete process.env.CUBE_API_KEY;
      delete process.env.E2B_API_KEY;
      delete process.env.CUBE_API_URL;
      delete process.env.E2B_API_URL;
      await expect(createClient()).rejects.toThrow(/api key is required/i);
      process.env.CUBE_API_KEY = "test-key";
      await expect(createClient()).rejects.toThrow(/api url is required/i);
      expect(process.env.E2B_API_KEY).toBe("test-key");
      process.env.CUBE_API_URL = "http://127.0.0.1:3000";
      const client = await createClient();
      expect(process.env.E2B_API_URL).toBe("http://127.0.0.1:3000");
      expect(typeof client.create).toBe("function");
      expect(typeof client.connect).toBe("function");
      expect(typeof client.list).toBe("function");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});

describe("cube-manager up binding shape", () => {
  it("creates the bound remote workspace before returning a new sandbox", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-up-workspace-"));
    try {
      const sandbox = fakeSandbox({ sandboxId: "sbx-new" });
      const client = { create: async () => sandbox };
      await handleUp({ directory: root, template: "base", client, json: true });
      expect(sandbox._commands).toContain(`mkdir -p '/home/user/workspace/${path.basename(root)}'`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("creates a sandbox, persists a binding using the 'template' field for the Cube template id, and reports lifecycle honestly", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-up-"));
    try {
      const created = [];
      const sandbox = fakeSandbox({ sandboxId: "sbx-new" });
      const client = { connect: async () => { throw { name: "SandboxNotFoundError" }; }, create: async (opts) => { created.push(opts); return sandbox; } };
      const result = await handleUp({ directory: root, template: "base", client, json: true });
      expect(result.sandboxId).toBe("sbx-new");
      expect(result.template).toBe("base");
      expect(result.warning).toMatch(/no cube\/e2b equivalent/i);
      expect(created[0]).toMatchObject({ template: "base" });
      expect(created[0].metadata).toMatchObject({ "sandbox-ctl.managed": "true", "sandbox-ctl.adapter": "cube" });
      const config = readConfig(root);
      const binding = Object.values(config.sandboxes)[0];
      expect(binding.sandboxId).toBe("sbx-new");
      expect(binding.template).toBe("base");
      expect(config.adapter).toBe("cube");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reuses an existing bound sandbox instead of creating a new one", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-up-reuse-"));
    try {
      bindConfig(root, { template: "base" });
      const sandbox = fakeSandbox({ sandboxId: "sbx-1" });
      const create = vi.fn();
      const client = { connect: async (id) => { expect(id).toBe("sbx-1"); return sandbox; }, create };
      const result = await handleUp({ directory: root, client, json: true });
      expect(result.sandboxId).toBe("sbx-1");
      expect(create).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cube-manager resolveProjectPaths", () => {
  it("resolves an explicit sandbox selector and errors when it does not exist", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cube-paths-"));
    try {
      bindConfig(root);
      expect(resolveProjectPaths({ directory: root }).binding).toMatchObject({ sandboxId: "sbx-1" });
      expect(() => resolveProjectPaths({ directory: root, sandbox: "missing" })).toThrow(/sandbox binding not found/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
