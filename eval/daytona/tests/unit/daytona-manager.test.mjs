import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyDaytonaEnv,
  assertRemoteCommandSuccess,
  buildUsage,
  createBundle,
  downloadFile,
  listTarEntries,
  loadEnvFile,
  parseArgs,
  redactStateForDisplay,
  resolveEnvFile,
  resolveProjectPaths,
  sandboxExec,
  sanitizeTaskId,
  shellQuote,
  uploadFile,
  validateTarEntries
} from "../../../../skills/daytona-companion/scripts/daytona-manager.mjs";

describe("daytona-manager args", () => {
  it("parses command options and passthrough command", () => {
    const parsed = parseArgs(["exec", "--directory", "/tmp/project", "--cwd", "/workspace/task", "--", "pnpm", "test"]);

    expect(parsed.command).toBe("exec");
    expect(parsed.options).toEqual({ directory: "/tmp/project", cwd: "/workspace/task" });
    expect(parsed.passthrough).toEqual(["pnpm", "test"]);
  });

  it("throws on unknown options", () => {
    expect(() => parseArgs(["up", "--bad"])).toThrow("Unknown option: --bad");
  });
});

describe("daytona-manager env loading", () => {
  it("loads env files as key values without exposing values in display redaction", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-env-test-"));
    try {
      const envFile = path.join(dir, "sample.env");
      writeFileSync(envFile, "DAYTONA_API_TOKEN=super-secret-token\nVISIBLE=value\n# ignored\n");

      const env = loadEnvFile(envFile);
      expect(env).toEqual({ DAYTONA_API_TOKEN: "super-secret-token", VISIBLE: "value" });
      expect(redactStateForDisplay(env)).toEqual({ DAYTONA_API_TOKEN: "[redacted]", VISIBLE: "value" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults env file resolution to project .env.local when present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-env-default-test-"));
    try {
      const envFile = path.join(dir, ".env.local");
      writeFileSync(envFile, "DAYTONA_API_TOKEN=fake-token\n");

      expect(resolveEnvFile({}, resolveProjectPaths({ directory: dir }))).toBe(envFile);
      expect(resolveEnvFile({ "env-file": path.join(dir, "custom.env") }, resolveProjectPaths({ directory: dir }))).toBe(path.join(dir, "custom.env"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps DAYTONA_API_TOKEN to DAYTONA_API_KEY without overriding an existing key", () => {
    const oldKey = process.env.DAYTONA_API_KEY;
    const oldToken = process.env.DAYTONA_API_TOKEN;
    try {
      delete process.env.DAYTONA_API_KEY;
      delete process.env.DAYTONA_API_TOKEN;
      applyDaytonaEnv({ DAYTONA_API_TOKEN: "token-value" });
      expect(process.env.DAYTONA_API_KEY).toBe("token-value");

      process.env.DAYTONA_API_KEY = "existing-key";
      applyDaytonaEnv({ DAYTONA_API_TOKEN: "new-token" });
      expect(process.env.DAYTONA_API_KEY).toBe("existing-key");
    } finally {
      if (oldKey === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = oldKey;
      if (oldToken === undefined) delete process.env.DAYTONA_API_TOKEN;
      else process.env.DAYTONA_API_TOKEN = oldToken;
    }
  });
});

describe("daytona-manager sdk wrappers", () => {
  it("passes cwd as a string to executeCommand and as an object to exec", async () => {
    const executeCalls = [];
    await sandboxExec({ process: { executeCommand: async (...args) => executeCalls.push(args) } }, "pwd", "/workspace");
    expect(executeCalls).toEqual([["pwd", "/workspace"]]);

    const execCalls = [];
    await sandboxExec({ process: { exec: async (...args) => execCalls.push(args) } }, "pwd", "/workspace");
    expect(execCalls).toEqual([["pwd", { cwd: "/workspace" }]]);
  });

  it("uploads file bytes instead of a local path string", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-upload-test-"));
    try {
      const file = path.join(dir, "bundle.tgz");
      writeFileSync(file, "bundle-bytes");
      const calls = [];
      await uploadFile({ fs: { uploadFile: async (...args) => calls.push(args) } }, file, "/tmp/bundle.tgz");

      expect(Buffer.isBuffer(calls[0][0])).toBe(true);
      expect(calls[0][0].toString()).toBe("bundle-bytes");
      expect(calls[0][1]).toBe("/tmp/bundle.tgz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes returned download bytes to the requested local path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-download-test-"));
    try {
      const output = path.join(dir, "artifacts.tgz");
      await downloadFile({ fs: { downloadFile: async (remotePath) => Buffer.from(`bytes:${remotePath}`) } }, "/tmp/artifacts.tgz", output);

      expect(readFileSync(output, "utf8")).toBe("bytes:/tmp/artifacts.tgz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daytona-manager tar bundles", () => {
  it("archives directory contents rather than the directory basename", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-bundle-test-"));
    let bundle;
    try {
      const project = path.join(dir, "project-name");
      mkdirSync(project, { recursive: true });
      writeFileSync(path.join(project, "stdout.txt"), "hello");

      bundle = createBundle(project, "task-123");
      const entries = listTarEntries(bundle.bundlePath).map((entry) => entry.replace(/^\.\//, ""));

      expect(entries).toContain("stdout.txt");
      expect(entries).not.toContain("project-name/stdout.txt");
    } finally {
      bundle?.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps single-file bundles under their basename", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-file-bundle-test-"));
    let bundle;
    try {
      const file = path.join(dir, "input.txt");
      writeFileSync(file, "hello");

      bundle = createBundle(file, "task-123");
      expect(listTarEntries(bundle.bundlePath)).toContain("input.txt");
    } finally {
      bundle?.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe artifact tar entries before extraction", () => {
    expect(validateTarEntries(["./stdout.txt", "nested/stderr.txt"])).toEqual(["./stdout.txt", "nested/stderr.txt"]);
    for (const entry of ["/tmp/evil", "../evil", "safe/../../evil", "C:/evil"]) {
      expect(() => validateTarEntries([entry])).toThrow("Unsafe tar entry rejected");
    }
  });
});

describe("daytona-manager shell quoting", () => {
  it("quotes simple command arguments", () => {
    expect(["pnpm", "test"].map(shellQuote).join(" ")).toBe("'pnpm' 'test'");
  });

  it("preserves spaces and redirection as literal argument text", () => {
    expect(shellQuote("cat a > b")).toBe("'cat a > b'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's ok")).toBe("'it'\"'\"'s ok'");
  });

  it("quotes empty strings", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("daytona-manager paths", () => {
  it("resolves home/global state and project-local artifact paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-path-test-"));
    const stateRoot = mkdtempSync(path.join(tmpdir(), "daytona-state-root-test-"));
    try {
      const paths = resolveProjectPaths({ directory: dir, "state-directory": stateRoot, "task-id": "task-123" });

      expect(paths.directory).toBe(path.resolve(dir));
      expect(paths.stateRoot).toBe(path.resolve(stateRoot));
      expect(paths.stateFile).toMatch(new RegExp(`${stateRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/projects/[a-f0-9]{16}\\.json$`));
      expect(paths.legacyStateFile).toBe(path.join(path.resolve(dir), ".daytona", "state.json"));
      expect(paths.remoteWorkspacePath).toBe("workspace/task-123");
      expect(paths.remoteArtifactsPath).toBe("artifacts/daytona/task-123");
      expect(paths.localArtifactsPath).toBe(path.join(path.resolve(dir), "artifacts", "daytona", "task-123"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("uses sanitized legacy state-loaded task ids for paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daytona-state-task-test-"));
    try {
      mkdirSync(path.join(dir, ".daytona"), { recursive: true });
      writeFileSync(path.join(dir, ".daytona", "state.json"), JSON.stringify({ taskId: "state.task-1" }));

      const paths = resolveProjectPaths({ directory: dir });
      expect(paths.taskId).toBe("state.task-1");
      expect(paths.localArtifactsPath).toBe(path.join(path.resolve(dir), "artifacts", "daytona", "state.task-1"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe explicit and legacy state-loaded task ids", () => {
    for (const bad of ["../bad", "a/b", "", ".", "..", "bad task"]) {
      expect(() => sanitizeTaskId(bad)).toThrow("Invalid");
    }

    const dir = mkdtempSync(path.join(tmpdir(), "daytona-bad-state-task-test-"));
    try {
      mkdirSync(path.join(dir, ".daytona"), { recursive: true });
      writeFileSync(path.join(dir, ".daytona", "state.json"), JSON.stringify({ taskId: "../bad" }));

      expect(() => resolveProjectPaths({ directory: dir })).toThrow("Invalid task id");
      expect(() => resolveProjectPaths({ directory: dir, "task-id": "a/b" })).toThrow("Invalid task id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daytona companion skill docs", () => {
  it("documents direct manager invocation instead of command wrappers", () => {
    const skillPath = path.resolve("skills/daytona-companion/SKILL.md");
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("skills/daytona-companion/scripts/daytona-manager.mjs");
    expect(content).toContain("slash commands are removed/replaced");
    expect(content).not.toContain("${CLAUDE_PLUGIN_ROOT}/plugins/");
  });
});

describe("daytona-manager remote command results", () => {
  it("allows missing or zero exit codes", () => {
    expect(assertRemoteCommandSuccess(undefined, "push extraction")).toBeUndefined();
    expect(assertRemoteCommandSuccess({ exitCode: 0, stdout: "ok" }, "push extraction")).toEqual({ exitCode: 0, stdout: "ok" });
  });

  it("throws with stderr/stdout when a remote command exits nonzero", () => {
    expect(() =>
      assertRemoteCommandSuccess({ exitCode: 2, stderr: "tar failed", stdout: "partial" }, "pull artifact bundling")
    ).toThrow("pull artifact bundling failed with exit code 2. stderr: tar failed stdout: partial");
  });
});

describe("daytona-manager usage", () => {
  it("includes all command names", () => {
    const usage = buildUsage();
    for (const command of ["up", "status", "push", "exec", "pull", "down"]) {
      expect(usage).toContain(command);
    }
  });
});
