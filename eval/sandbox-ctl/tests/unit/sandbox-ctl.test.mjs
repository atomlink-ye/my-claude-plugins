import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  buildLifecycleLabels,
  normalizeLifecycleOptions,
  parseSandboxCtlArgs,
  resolveCommandAlias,
  runSandboxCtl,
} from "../../../../skills/sandbox-ctl/scripts/sandbox-ctl.mjs";
import {
  assertManagedSandbox,
  buildSandboxCreateParams,
  runDoctorCheck,
  createSandboxWithFallback,
  readProjectState,
  resolveProjectPaths,
  writeProvisionalSandboxState,
  readProjectStateWithSource,
  handleDown,
  handleAdopt,
  removeStateSource,
  buildSmokeTestOptions,
  migrateLegacyStateToConfig,
  handleUp,
} from "../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs";
import * as daytonaAdapter from "../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readConfig, writeConfig, upsertBinding } from "../../../../skills/sandbox-ctl/scripts/project-config.mjs";

describe("sandbox-ctl argument parsing", () => {
  it("forwards exec timeout to the adapter", () => {
    const parsed = parseSandboxCtlArgs(["exec", "--timeout", "30m", "--", "make", "setup"]);
    expect(parsed.forwarded).toEqual(["--timeout", "30m"]);
    expect(parsed.passthrough).toEqual(["make", "setup"]);
  });

  it("supports local binding selection and no-use lifecycle controls", () => {
    const parsed = parseSandboxCtlArgs(["up", "--sandbox", "dev", "--name", "named", "--no-use"]);
    expect(parsed.options).toMatchObject({ sandbox: "dev", name: "named", noUse: true });
  });

  it("fails closed when an explicit sandbox binding is missing", async () => {
    const root = mkdtempSync(`${tmpdir()}/sandbox-select-`);
    try {
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "/workspace/dev" } } });
      const calls = [];
      const adapter = { parseArgs: () => ({ options: {}, positionals: [], passthrough: [] }), handleStatus: async () => { calls.push("status"); return { ok: true }; } };
      await expect(runSandboxCtl(["status", "--directory", root, "--sandbox", "missing"], { adapter })).rejects.toThrow(/binding.*not found/i);
      expect(calls).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("supports help, adapter selection, json, repeated labels, and lifecycle flags", () => {
    const parsed = parseSandboxCtlArgs([
      "--adapter", "daytona", "--json", "task", "up", "--label", "team=infra",
      "--label=env=test", "--auto-stop", "45", "--auto-archive", "120", "--auto-delete", "90",
      "--ephemeral", "--", "ignored",
    ]);
    expect(parsed.adapter).toBe("daytona");
    expect(parsed.json).toBe(true);
    expect(parsed.command).toBe("task");
    expect(parsed.positionals).toEqual(["up"]);
    expect(parsed.passthrough).toEqual(["ignored"]);
    expect(parsed.options.labels).toEqual({ team: "infra", env: "test" });
    expect(parsed.options.autoStopInterval).toBe(45);
    expect(parsed.options.autoArchiveInterval).toBe(120);
    expect(parsed.options.autoDeleteInterval).toBe(90);
    expect(parsed.options.ephemeral).toBe(true);
  });

  it("resolves aliases and rejects unknown adapters", () => {
    expect(resolveCommandAlias("create")).toEqual({ command: "up", kind: "sandbox" });
    expect(resolveCommandAlias("delete")).toEqual({ command: "down", kind: "task" });
    expect(resolveCommandAlias("finish")).toEqual({ command: "down", kind: "task" });
    expect(resolveCommandAlias("task", "up")).toEqual({ command: "up", kind: "sandbox" });
    expect(resolveCommandAlias("project", "up")).toEqual({ command: "up", kind: "sandbox" });
    expect(() => parseSandboxCtlArgs(["--adapter", "other", "list"])).toThrow(/Unknown adapter/);
  });
});

describe("sandbox-ctl lifecycle policy", () => {
  it("uses one sandbox policy for every up alias and exposes a warning", () => {
    expect(normalizeLifecycleOptions("sandbox", {})).toMatchObject({ autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60 });
    expect(buildLifecycleLabels("sandbox", {})).toMatchObject({ "sandbox-ctl.kind": "sandbox", "sandbox-ctl.policy": "sandbox-v1" });
  });
  it("applies task and project defaults and explicit overrides", () => {
    expect(normalizeLifecycleOptions("task", {})).toMatchObject({
      autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60,
    });
    expect(normalizeLifecycleOptions("project", {})).toMatchObject({
      autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60,
    });
    expect(normalizeLifecycleOptions("task", { autoStopInterval: 0 })).toMatchObject({
      autoStopInterval: 0,
    });
    expect(normalizeLifecycleOptions("project", { ephemeral: true }).autoDeleteInterval).toBe(0);
  });

  it("adds managed policy labels while preserving user labels", () => {
    expect(buildLifecycleLabels("project", { team: "infra" })).toEqual({
      team: "infra",
      "sandbox-ctl.managed": "true",
      "sandbox-ctl.kind": "sandbox",
      "sandbox-ctl.adapter": "daytona",
      "sandbox-ctl.policy": "sandbox-v1",
    });
  });
});

describe("sandbox-ctl dispatch", () => {
  function fakeAdapter(calls) {
    return {
      parseArgs: (argv) => ({ command: argv[0], options: {}, positionals: [], passthrough: [] }),
      handleUp: async (options) => { calls.push(["up", options]); return { sandboxId: "sandbox-1" }; },
      handleDown: async (options) => { calls.push(["down", options]); return { sandboxId: "sandbox-1" }; },
      handleExec: async (_options, command) => { calls.push(["exec", command]); return { exitCode: 7 }; },
      handleList: async () => ({ sandboxes: [] }),
      handleDoctor: async () => ({ ok: true, connected: true }),
    };
  }

  it("prints help as stable JSON", async () => {
    const result = await runSandboxCtl(["--json", "--help"]);
    expect(result).toMatchObject({ ok: true, command: "help", adapter: "daytona" });
  });

  it("forwards legacy commands and aliases to adapter handlers", async () => {
    const calls = [];
    const adapter = fakeAdapter(calls);
    await runSandboxCtl(["up"], { adapter });
    await runSandboxCtl(["create"], { adapter });
    await runSandboxCtl(["delete"], { adapter });
    await runSandboxCtl(["finish"], { adapter });
    expect(calls.map(([name]) => name)).toEqual(["up", "up", "down", "down"]);
  });

  it("prints one deprecated warning for task/project/create aliases", async () => {
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runSandboxCtl(["task", "up"], { adapter: fakeAdapter([]) });
      expect(logs.filter((line) => /deprecated/i.test(line))).toHaveLength(1);
    } finally { console.log = originalLog; }
  });

  it("migrates legacy hashed state to a local binding", async () => {
    const dir = mkdtempSync(`${tmpdir()}/legacy-migrate-`);
    try {
      const legacy = `${dir}/.daytona`;
      mkdirSync(legacy, { recursive: true });
      writeFileSync(`${legacy}/state.json`, JSON.stringify({ sandboxId: "legacy-s1", taskId: "legacy-task", remoteWorkspacePath: "/workspace/legacy-task" }));
      const paths = resolveProjectPaths({ directory: dir, "state-directory": dir });
      const binding = migrateLegacyStateToConfig(paths, readProjectState(paths));
      expect(binding).toMatchObject({ name: "legacy-task", sandboxId: "legacy-s1", remoteWorkspace: "/workspace/legacy-task" });
      expect(readConfig(dir).sandboxes["legacy-task"]).toMatchObject({ sandboxId: "legacy-s1" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps provisional binding and lifecycle warning on real handler start failure", async () => {
    const dir = mkdtempSync(`${tmpdir()}/up-start-failure-`);
    try {
      const client = {
        get: async () => null,
        create: async () => ({ id: "created-s1", state: "stopped", start: async () => { throw new Error("start failed"); } }),
      };
      const failure = await handleUp({ directory: dir, client, name: "recoverable", autoStopInterval: 5, autoArchiveInterval: 10, autoDeleteInterval: 15 }).catch((error) => error);
      expect(failure).toMatchObject({ sandboxId: "created-s1", nextActions: expect.any(Array) });
      expect(failure.nextActions[0]).toContain("--remote-path 'workspace/up-start-failure-");
      expect(readConfig(dir).sandboxes.recoverable).toMatchObject({ sandboxId: "created-s1", lifecycle: { autoStopInterval: 5, autoDeleteInterval: 15 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns lifecycle warning from real handler success", async () => {
    const dir = mkdtempSync(`${tmpdir()}/up-warning-`);
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const result = await handleUp({ directory: dir, client: { get: async () => null, create: async () => ({ id: "warning-s1" }) }, autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60 });
      expect(result).toMatchObject({ lifecycle: { autoStopInterval: 30, autoDeleteInterval: 60 }, warning: expect.stringMatching(/30 minutes.*60 minutes.*lost/i) });
      expect(logs.join(" ")).toMatch(/30 minutes.*60 minutes.*lost/i);
    } finally { console.log = originalLog; rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns cleanup recovery metadata when provisional config write is busy", async () => {
    const dir = mkdtempSync(`${tmpdir()}/up-config-busy-`);
    try {
      mkdirSync(`${dir}/.sandbox-ctl`, { recursive: true });
      writeFileSync(`${dir}/.sandbox-ctl/config.json.lock`, "held");
      const failure = await handleUp({ directory: dir, client: { get: async () => null, create: async () => ({ id: "busy-s1" }) } }).catch((error) => error);
      expect(failure).toMatchObject({ sandboxId: "busy-s1", nextActions: [
        expect.stringMatching(/adopt .*--sandbox-id 'busy-s1'.*--name 'recovery-busy-s1'.*--remote-path 'workspace\/up-config-busy-.*'/),
        expect.stringMatching(/down .*--sandbox 'recovery-busy-s1'/),
      ] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails before contacting the client when adopt has no reliable remote path", async () => {
    const dir = mkdtempSync(`${tmpdir()}/adopt-no-remote-`);
    const calls = [];
    const client = {
      get: async () => { calls.push("get"); throw new Error("client should not be called"); },
      list: async () => { calls.push("list"); throw new Error("client should not be called"); },
    };
    try {
      await expect(handleAdopt({ directory: dir, client, "sandbox-id": "remote-s1" })).rejects.toThrow(/--remote-path/);
      expect(calls).toEqual([]);
      expect(existsSync(path.join(dir, ".sandbox-ctl", "config.json"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("adopts with an explicit remote path and persists it unchanged", async () => {
    const dir = mkdtempSync(`${tmpdir()}/adopt-explicit-`);
    const remotePath = "workspace/with space/and 'quote'";
    const originalLog = console.log;
    console.log = () => {};
    try {
      const result = await handleAdopt({
        directory: dir,
        client: { get: async () => ({ id: "remote-s1", name: "remote-name", state: "started" }) },
        "sandbox-id": "remote-s1",
        "remote-path": remotePath,
        name: "adopted",
      });
      expect(result.remoteWorkspace).toBe(remotePath);
      expect(readConfig(dir).sandboxes.adopted.remoteWorkspace).toBe(remotePath);
    } finally { console.log = originalLog; rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the exact-directory binding remote path when adopting without an explicit path", async () => {
    const dir = mkdtempSync(`${tmpdir()}/adopt-binding-`);
    const remotePath = "/workspace/existing-binding";
    const originalLog = console.log;
    console.log = () => {};
    try {
      writeConfig(dir, { schemaVersion: 1, adapter: "daytona", active: "existing", sandboxes: { existing: { sandboxId: "remote-s1", remoteWorkspace: remotePath } } });
      await handleAdopt({ directory: dir, client: { get: async () => ({ id: "remote-s1", name: "remote-name", state: "started" }) }, "sandbox-id": "remote-s1" });
      expect(readConfig(dir).sandboxes.existing.remoteWorkspace).toBe(remotePath);
    } finally { console.log = originalLog; rmSync(dir, { recursive: true, force: true }); }
  });

  it("quotes the known remote workspace in recovery actions", async () => {
    const dir = mkdtempSync(`${tmpdir()}/recovery-remote-quote-`);
    const remotePath = "/workspace/with space/and 'quote'";
    try {
      writeConfig(dir, { schemaVersion: 1, adapter: "daytona", active: "existing", sandboxes: { existing: { sandboxId: "remote-s1", remoteWorkspace: remotePath } } });
      const failure = await handleUp({
        directory: dir,
        client: { get: async () => ({ id: "remote-s1", state: "stopped", start: async () => { throw new Error("start failed"); } }) },
      }).catch((error) => error);
      expect(failure.nextActions[0]).toBe(`sandbox-ctl adopt --directory '${dir}' --sandbox-id 'remote-s1' --name 'recovery-remote-s1' --remote-path '/workspace/with space/and '"'"'quote'"'"''`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns remote exec exit code without collapsing it to one", async () => {
    const result = await runSandboxCtl(["--json", "exec", "--", "false"], { adapter: fakeAdapter([]) });
    expect(result).toMatchObject({ ok: false, command: "exec", exitCode: 7 });
  });

  it("forwards the top-level exec passthrough command when the adapter parser has none", async () => {
    const calls = [];
    const adapter = fakeAdapter(calls);
    await runSandboxCtl(["--json", "exec", "--", "sh", "-lc", "echo hi"], { adapter });
    expect(calls).toContainEqual(["exec", ["sh", "-lc", "echo hi"]]);
  });

  it("dispatches task/project policy defaults and inventory diagnostics", async () => {
    const calls = [];
    const adapter = fakeAdapter(calls);
    await runSandboxCtl(["project", "up"], { adapter });
    expect(calls[0][1]).toMatchObject({ autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60 });
    await expect(runSandboxCtl(["list"], { adapter })).resolves.toMatchObject({ sandboxes: [] });
    await expect(runSandboxCtl(["doctor"], { adapter })).resolves.toMatchObject({ connected: true });
  });
});

describe("sandbox-ctl hardening", () => {
  it("does not swallow boolean flags before a command", () => {
    const parsed = parseSandboxCtlArgs(["--refresh", "status"]);
    expect(parsed.forwarded).toEqual(["--refresh"]);
    expect(parsed.command).toBe("status");
  });

  it("rejects project deletion and unmanaged or mismatched remote objects", () => {
    expect(() => resolveCommandAlias("project", "down")).toThrow(/project.*delete/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "false" } }, "task")).toThrow(/managed/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "project", "sandbox-ctl.policy": "project-v1" } }, "task")).toThrow(/kind/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "task", "sandbox-ctl.policy": "task-v1", taskId: "other" } }, "task", undefined, "current")).toThrow(/taskId/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "task", "sandbox-ctl.policy": "task-v1" }, autoDeleteInterval: 0 }, "task", { ephemeral: true, autoDeleteInterval: 0 })).not.toThrow();
  });

  it("rejects destructive operations when managed sandbox identity points elsewhere", () => {
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "sandbox", "sandbox-ctl.policy": "sandbox-v1", "sandbox-ctl.project": "other" } }, "sandbox", undefined, undefined, "current")).toThrow(/identity/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "sandbox", "sandbox-ctl.policy": "sandbox-v1", taskId: "legacy" } }, "sandbox", undefined, "legacy", "current", { taskId: "legacy" })).toThrow(/identity/i);
    expect(() => assertManagedSandbox({ labels: { "sandbox-ctl.managed": "true", "sandbox-ctl.kind": "task", "sandbox-ctl.policy": "task-v1", taskId: "legacy" } }, "sandbox", undefined, "legacy", "current", { taskId: "legacy" })).not.toThrow();
  });

  it("retries class-derived resource rejection with params.resources removed", async () => {
    const calls = [];
    const client = { create: async (params) => { calls.push(params); if (params.resources) throw new Error("class resources rejected"); return { id: "s1" }; } };
    await expect(createSandboxWithFallback(client, { resources: { cpu: 1 }, labels: {} }, {})).resolves.toEqual({ id: "s1" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("resources");
  });

  it("does not persist deprecated ttl metadata in SDK create params", () => {
    const params = buildSandboxCreateParams({ ttlMinutes: 90, labels: { team: "infra" }, ephemeral: true }, { taskId: "t" });
    expect(params.labels).not.toHaveProperty("sandbox-ctl.ttlMinutes");
    expect(params).not.toHaveProperty("ttlMinutes");
    expect(params.ephemeral).toBe(true);
  });

  it("builds managed task labels and lifecycle for smoke-test creation", () => {
    const smoke = buildSmokeTestOptions({}, "/tmp/smoke-test-dir", "/tmp/smoke-state-dir", "smoke-task");
    const params = buildSandboxCreateParams(smoke, { taskId: smoke["task-id"] });
    expect(params.labels).toMatchObject({
      "sandbox-ctl.managed": "true",
      "sandbox-ctl.kind": "sandbox",
      "sandbox-ctl.adapter": "daytona",
      "sandbox-ctl.policy": "sandbox-v1",
      taskId: "smoke-task",
    });
    expect(params).toMatchObject({ autoStopInterval: 30, autoArchiveInterval: 10080, autoDeleteInterval: 60 });
    expect(smoke).toMatchObject({ expectedKind: "sandbox", requireManagedPolicy: true });
  });

  it("doctor calls list and redacts configured credentials", async () => {
    const result = await runDoctorCheck({
      createClient: async () => ({ list: async () => [{ id: "s1" }] }),
      env: { DAYTONA_API_KEY: "super-secret", DAYTONA_API_URL: "https://user:pass@example.test" },
    });
    expect(result.connected).toBe(true);
    expect(result.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("user:pass");
  });

  it("returns one JSON error object and sets exact exec exit code", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logs = [];
    const originalLog = console.log;
    console.log = (value) => logs.push(String(value));
    try {
      await runSandboxCtl(["--json", "unknown-command"], { adapter: { parseArgs: () => ({ options: {}, positionals: [], passthrough: [] }) } });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0])).toMatchObject({ ok: false, command: "unknown-command", adapter: "daytona" });
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  });

  it("sets exit 1 for a failed doctor and includes exec stdout/stderr in JSON", () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const doctor = spawnSync(process.execPath, [path.join(process.cwd(), "skills/sandbox-ctl/scripts/sandbox-ctl.mjs"), "--json", "doctor"], { encoding: "utf8", env: { ...process.env, SANDBOX_CTL_ADAPTER_MODULE: path.join(process.cwd(), "eval/sandbox-ctl/tests/fixtures/doctor-fail-adapter.mjs") } });
    expect(doctor.status).toBe(1);
    expect(doctor.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: false, command: "doctor" });
    process.exitCode = originalExitCode;
  });

  it("propagates exit 7 through a real CLI spawn", () => {
    const root = path.resolve(process.cwd());
    const cli = path.join(root, "skills/sandbox-ctl/scripts/sandbox-ctl.mjs");
    const fixture = path.join(root, "eval/sandbox-ctl/tests/fixtures/exit7-adapter.mjs");
    const child = spawnSync(process.execPath, [cli, "--json", "exec", "--", "false"], {
      encoding: "utf8",
      env: { ...process.env, SANDBOX_CTL_ADAPTER_MODULE: fixture },
    });
    expect(child.status).toBe(7);
    expect(child.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, command: "exec", exitCode: 7, stdout: "fixture stdout", stderr: "fixture stderr" });
  });
});

describe("sandbox-ctl run", () => {
  function runAdapter(calls, { execCode = 0, failAt, cleanupFails = false } = {}) {
    const maybeFail = (name) => { if (failAt === name) throw new Error(`${name} failed`); };
    return {
      parseArgs: (argv) => {
        const options = {};
        for (let i = 1; i < argv.length; i += 1) if (["--directory", "--path", "--output", "--task-id"].includes(argv[i])) options[argv[i].slice(2)] = argv[++i];
        return { command: argv[0], options, positionals: [], passthrough: [] };
      },
      handleUp: async (options) => { calls.push(["up", options]); maybeFail("up"); return { sandboxId: "sandbox-run-1" }; },
      handlePush: async (options) => { calls.push(["push", options]); maybeFail("push"); return { ok: true }; },
      handleExec: async (options, command) => { calls.push(["exec", options, command]); maybeFail("exec"); process.stdout.write("stream stdout"); process.stderr.write("stream stderr"); return { exitCode: execCode }; },
      handlePull: async (options) => { calls.push(["pull", options]); maybeFail("pull"); return { ok: true, output: options.output }; },
      handleDown: async (options) => { calls.push(["down", options]); if (cleanupFails) throw new Error("cleanup failed"); return { ok: true }; },
    };
  }

  it("runs up, safe bundle push, exec, and exact named down in order", async () => {
    const calls = [];
    const result = await runSandboxCtl(["--json", "run", "--", "echo", "ok"], { adapter: runAdapter(calls) });
    expect(result).toMatchObject({ ok: true, command: "run", adapter: "daytona", sandboxId: "sandbox-run-1", exitCode: 0, retained: false });
    expect(result.bindingName).toMatch(/^run-/);
    expect(result.configPath).toMatch(/\.sandbox-ctl\/config\.json$/);
    expect(calls.map(([name]) => name)).toEqual(["up", "push", "exec", "down"]);
    expect(calls[0][1]).toMatchObject({ name: result.bindingName, noUse: true });
    expect(calls[1][1].mode ?? "bundle").toBe("bundle");
    expect(calls[3][1]).toMatchObject({ sandbox: result.bindingName });
    expect(calls[3][1]).not.toHaveProperty("sandbox-name");
    expect(calls[3][1]).not.toHaveProperty("sandbox-id");
  });

  it("retains adapter recovery actions after a partial up binding failure", async () => {
    const calls = [];
    const recovery = [
      "sandbox-ctl adopt --directory '/work' --sandbox-id 'new-remote-id' --name 'recovery-run'",
      "sandbox-ctl down --directory '/work' --sandbox 'recovery-run'",
    ];
    const adapter = runAdapter(calls);
    adapter.handleUp = async () => {
      const error = new Error("config upsert failed");
      error.sandboxId = "new-remote-id";
      error.nextActions = recovery;
      throw error;
    };
    adapter.handleDown = async () => { throw new Error("run binding does not exist"); };
    const result = await runSandboxCtl(["--json", "run", "--", "echo", "ok"], { adapter });
    expect(result).toMatchObject({ ok: false, retained: true, sandboxId: "new-remote-id", exitCode: 125 });
    expect(result.nextActions).toEqual(recovery);
    expect(result.nextActions.join(" ")).not.toMatch(/--sandbox 'run-/);
  });

  it("cleans a recorded run binding even when up finalize reports recovery actions", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-recorded-recovery-`);
    try {
      const calls = [];
      const adapter = runAdapter(calls);
      adapter.handleUp = async (options) => {
        calls.push(["up", options]);
        upsertBinding(dir, options.name, { sandboxId: "new-remote-id", remoteWorkspace: "/workspace/run" }, { use: false });
        const error = new Error("startup finalize failed");
        error.sandboxId = "new-remote-id";
        error.nextActions = ["sandbox-ctl adopt --sandbox-id 'new-remote-id' --name 'recovery-run'"];
        throw error;
      };
      adapter.handleDown = async (options) => {
        calls.push(["down", options]);
        expect(options.sandbox).toMatch(/^run-/);
        return { ok: true };
      };
      const result = await runSandboxCtl(["--json", "run", "--directory", dir, "--", "echo", "ok"], { adapter });
      expect(result).toMatchObject({ ok: false, retained: false, sandboxId: "new-remote-id", exitCode: 125, nextActions: [] });
      expect(calls.map(([name]) => name)).toEqual(["up", "down"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the explicit run binding for every post-up phase", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-bound-phases-`);
    try {
      writeConfig(dir, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "active-s1", remoteWorkspace: "/workspace/dev" } } });
      const calls = [];
      const adapter = runAdapter(calls);
      adapter.handleUp = async (options) => {
        upsertBinding(dir, options.name, { sandboxId: "run-s1", remoteWorkspace: "/workspace/run" }, { use: false });
        calls.push(["up", options]);
        return { sandboxId: "run-s1" };
      };
      for (const phase of ["handlePush", "handleExec", "handleDown"]) {
        const original = adapter[phase];
        adapter[phase] = async (options, ...rest) => {
          const resolved = resolveProjectPaths({ ...options, directory: dir });
          expect(resolved.binding?.name).toMatch(/^run-/);
          expect(options.sandbox).toMatch(/^run-/);
          expect(options.ignoreActiveBinding).toBe(false);
          expect(options.ignoreState).toBe(false);
          expect(options).not.toHaveProperty("sandbox-name");
          expect(options).not.toHaveProperty("sandbox-id");
          return original(options, ...rest);
        };
      }
      const result = await runSandboxCtl(["--json", "run", "--directory", dir, "--", "echo", "ok"], { adapter });
      expect(result).toMatchObject({ ok: true, sandboxId: "run-s1", exitCode: 0 });
      expect(readConfig(dir).active).toBe("dev");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed when run is given an existing sandbox selector", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-selector-`);
    try {
      writeConfig(dir, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "active-s1", remoteWorkspace: "/workspace/dev" } } });
      const calls = [];
      const result = await runSandboxCtl(["--json", "run", "--directory", dir, "--sandbox", "dev", "--", "echo", "ok"], { adapter: runAdapter(calls) });
      expect(result).toMatchObject({ ok: false, command: "run", exitCode: 125, bindingName: expect.stringMatching(/^run-/) });
      expect(calls).toEqual([]);
      expect(readConfig(dir).active).toBe("dev");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([["--mode", "git"], ["--mode", "full"], ["--include-sensitive"]])("rejects unsafe run transfer option %s", async (...args) => {
    const calls = [];
    const result = await runSandboxCtl(["--json", "run", ...args, "--", "echo", "ok"], { adapter: runAdapter(calls) });
    expect(result).toMatchObject({ ok: false, command: "run", exitCode: 125 });
    expect(calls).toEqual([]);
    expect(result.error).toMatch(/bundle|unsupported|safe|credential/i);
  });

  it("returns the complete control-error schema and exit 125 for a commandless real run", () => {
    const root = path.resolve(process.cwd());
    const child = spawnSync(process.execPath, [path.join(root, "skills/sandbox-ctl/scripts/sandbox-ctl.mjs"), "--json", "run"], { encoding: "utf8" });
    expect(child.status).toBe(125);
    expect(child.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, command: "run", exitCode: 125, bindingName: expect.stringMatching(/^run-/), configPath: expect.any(String), sandboxId: null, artifactPath: null, retained: false, warnings: expect.any(Array), nextActions: expect.any(Array), stdout: "", stderr: "", error: expect.any(String) });
  });

  it.each([["--auto-stop", "nope"], ["--label", "invalid"]])("returns stable run schema and 125 for top-level parse error %s", (flag, value) => {
    const root = path.resolve(process.cwd());
    const child = spawnSync(process.execPath, [path.join(root, "skills/sandbox-ctl/scripts/sandbox-ctl.mjs"), "--json", "run", flag, value, "--", "echo", "ok"], { encoding: "utf8" });
    expect(child.status).toBe(125);
    expect(child.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, command: "run", exitCode: 125, bindingName: expect.stringMatching(/^run-/), configPath: expect.any(String), sandboxId: null, artifactPath: null, retained: false, warnings: expect.any(Array), nextActions: expect.any(Array), stdout: "", stderr: "", error: expect.any(String) });
  });

  it("uses exit 125 and stderr for a human top-level run parse error", () => {
    const root = path.resolve(process.cwd());
    const child = spawnSync(process.execPath, [path.join(root, "skills/sandbox-ctl/scripts/sandbox-ctl.mjs"), "run", "--auto-stop", "nope", "--", "echo", "ok"], { encoding: "utf8" });
    expect(child.status).toBe(125);
    expect(child.stderr).toMatch(/invalid|integer/i);
    expect(child.stdout).toBe("");
  });

  it("returns stable schema and 125 for normalize and adapter parse failures", async () => {
    const normalized = await runSandboxCtl(["--json", "run", "--auto-stop", "-1", "--", "echo", "ok"], { adapter: runAdapter([]) });
    expect(normalized).toMatchObject({ ok: false, command: "run", exitCode: 125, bindingName: expect.stringMatching(/^run-/), sandboxId: null, artifactPath: null, retained: false, warnings: expect.any(Array), nextActions: expect.any(Array), stdout: "", stderr: "", error: expect.any(String) });
    const parsed = await runSandboxCtl(["--json", "run", "--", "echo", "ok"], { adapter: { parseArgs: () => { throw new Error("adapter parse failed"); } } });
    expect(parsed).toMatchObject({ ok: false, command: "run", exitCode: 125, bindingName: expect.stringMatching(/^run-/), sandboxId: null, artifactPath: null, retained: false, warnings: expect.any(Array), nextActions: expect.any(Array), stdout: "", stderr: "", error: expect.stringMatching(/parse failed/) });
  });

  it("creates a run binding without resolving or changing an existing active binding", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-active-binding-`);
    try {
      writeConfig(dir, {
        schemaVersion: 1,
        adapter: "daytona",
        active: "dev",
        sandboxes: { dev: { sandboxId: "active-s1", remoteWorkspace: "/workspace/dev" } },
      });
      const calls = [];
      const adapter = runAdapter(calls);
      adapter.handleUp = async (options) => {
        calls.push(["up", options]);
        expect(options.ignoreActiveBinding).toBe(true);
        return { sandboxId: "run-s1" };
      };
      const result = await runSandboxCtl(["--json", "run", "--directory", dir, "--", "echo", "ok"], { adapter });
      expect(result.bindingName).toMatch(/^run-/);
      expect(calls[0][1]).toMatchObject({ name: result.bindingName, noUse: true, ignoreActiveBinding: true });
      expect(readConfig(dir).active).toBe("dev");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("real up ignores active and legacy state only when run requests isolation", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-isolated-up-`);
    try {
      writeConfig(dir, {
        schemaVersion: 1,
        adapter: "daytona",
        active: "dev",
        sandboxes: { dev: { sandboxId: "active-s1", remoteWorkspace: "/workspace/dev" } },
      });
      const result = await handleUp({
        directory: dir,
        client: { get: async () => null, create: async () => ({ id: "run-s1" }) },
        name: "run-test",
        noUse: true,
        ignoreActiveBinding: true,
        ignoreState: true,
      });
      expect(result).toMatchObject({ sandboxId: "run-s1", name: "run-test" });
      expect(readConfig(dir).active).toBe("dev");
      expect(readConfig(dir).sandboxes["run-test"]).toMatchObject({ sandboxId: "run-s1" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("completes local artifacts before deleting after remote exit 7", async () => {
    const calls = [];
    const result = await runSandboxCtl(["--json", "run", "--", "false"], { adapter: runAdapter(calls, { execCode: 7 }) });
    expect(result).toMatchObject({ ok: false, exitCode: 7, retained: false, stdout: "stream stdout", stderr: "stream stderr" });
    expect(calls.map(([name]) => name)).toEqual(["up", "push", "exec", "down"]);
  });

  it("maps run output to local exec artifacts", async () => {
    const calls = [];
    const output = `${tmpdir()}/run-artifacts`;
    const result = await runSandboxCtl(["--json", "run", "--output", output, "--", "echo", "ok"], { adapter: runAdapter(calls) });
    expect(result.artifactPath).toBe(output);
    expect(calls.find(([name]) => name === "exec")[1].artifacts).toBe(output);
  });

  it("cleans up after push/exec/pull errors and keeps state only with --keep", async () => {
    const calls = [];
    await runSandboxCtl(["--json", "run", "--", "false"], { adapter: runAdapter(calls, { failAt: "push" }) });
    expect(calls.map(([name]) => name)).toEqual(["up", "push", "down"]);
    const keptCalls = [];
    const kept = await runSandboxCtl(["--json", "--keep", "run", "--", "false"], { adapter: runAdapter(keptCalls, { failAt: "exec" }) });
    expect(kept).toMatchObject({ ok: false, retained: true });
    expect(kept.nextActions.join(" ")).toMatch(/sandbox-ctl down .*--sandbox 'run-/);
    expect(keptCalls.map(([name]) => name)).toEqual(["up", "push", "exec"]);
  });

  it("reports cleanup failure without replacing a successful run's result", async () => {
    const calls = [];
    const result = await runSandboxCtl(["--json", "run", "--", "echo", "ok"], { adapter: runAdapter(calls, { cleanupFails: true }) });
    expect(result).toMatchObject({ ok: false, exitCode: 125, retained: true });
    expect(result.warnings.join(" ")).toMatch(/cleanup/i);
    expect(result.nextActions.join(" ")).toMatch(/sandbox-ctl down .*--sandbox 'run-/);
  });

  it("keeps a stable run JSON schema on success and failures", async () => {
    const fields = ["bindingName", "configPath", "sandboxId", "exitCode", "artifactPath", "retained", "warnings", "nextActions", "stdout", "stderr"];
    const success = await runSandboxCtl(["--json", "run", "--", "echo", "ok"], { adapter: runAdapter([]) });
    const execFailure = await runSandboxCtl(["--json", "run", "--", "false"], { adapter: runAdapter([], { failAt: "exec" }) });
    const upFailure = await runSandboxCtl(["--json", "run", "--", "false"], { adapter: runAdapter([], { failAt: "up" }) });
    for (const result of [success, execFailure, upFailure]) {
      expect(Object.keys(result)).toEqual(expect.arrayContaining(fields));
      expect(result.stdout).toBeTypeOf("string");
      expect(result.stderr).toBeTypeOf("string");
      expect(result.warnings).toEqual(expect.any(Array));
      expect(result.nextActions).toEqual(expect.any(Array));
    }
  });

  it("isolates legacy project state and emits an executable quoted retained action", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-legacy-`);
    const legacyDir = `${dir}/.daytona`;
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(`${legacyDir}/state.json`, JSON.stringify({ sandboxId: "legacy" }));
    const paths = resolveProjectPaths({ directory: dir, "state-directory": dir, ignoreLegacyState: true });
    expect(readProjectState(paths)).toBeNull();
    const calls = [];
    const result = await runSandboxCtl(["--json", "--keep", "run", "--directory", `${dir} with space`, "--", "false"], { adapter: runAdapter(calls, { failAt: "exec" }) });
    expect(result.nextActions.join(" ")).toMatch(/--directory '.* with space'/);
    expect(result.nextActions.join(" ")).toMatch(/--sandbox 'run-/);
    expect(result).not.toHaveProperty("stateDirectory");
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses directory as default push path, captures only exec streams, and writes provisional state", async () => {
    const calls = [];
    const result = await runSandboxCtl(["--json", "run", "--directory", "/tmp/run-dir", "--", "echo", "ok"], { adapter: runAdapter(calls) });
    expect(calls.find(([name]) => name === "push")[1].path).toBe("/tmp/run-dir");
    expect(result.stdout).toBe("stream stdout");
    expect(result.stderr).toBe("stream stderr");
    const dir = mkdtempSync(`${tmpdir()}/provisional-`);
    const paths = resolveProjectPaths({ directory: dir, "state-directory": dir, "task-id": "task" });
    writeProvisionalSandboxState(paths, { id: "sandbox" });
    expect(readProjectState(paths)).toMatchObject({ sandboxId: "sandbox", taskId: "task" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not leave hashed state after a successful run", async () => {
    const dir = mkdtempSync(`${tmpdir()}/run-no-state-`);
    const stateRoot = mkdtempSync(`${tmpdir()}/run-no-state-root-`);
    try {
      const adapter = {
        ...daytonaAdapter,
        handleUp: (options) => daytonaAdapter.handleUp({ ...options, client: { get: async () => null, create: async () => ({ id: "run-s1", state: "started" }) } }),
        handlePush: async () => ({ ok: true }),
        handleExec: async () => ({ exitCode: 0 }),
        handleDown: async () => ({ ok: true }),
      };

      const result = await runSandboxCtl(["--json", "run", "--directory", dir, "--state-directory", stateRoot, "--", "true"], { adapter });

      expect(result).toMatchObject({ ok: true, sandboxId: "run-s1", exitCode: 0 });
      expect(existsSync(path.join(stateRoot, "projects"))).toBe(false);
      expect(readdirSync(stateRoot, { recursive: true })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("deletes only the state file actually used as source", () => {
    const dir = mkdtempSync(`${tmpdir()}/state-source-`);
    const stateRoot = mkdtempSync(`${tmpdir()}/state-root-`);
    const paths = resolveProjectPaths({ directory: dir, "state-directory": stateRoot, "task-id": "task" });
    mkdirSync(paths.legacyStateDir, { recursive: true });
    writeFileSync(paths.legacyStateFile, JSON.stringify({ sandboxId: "legacy" }));
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.stateFile, JSON.stringify({ sandboxId: "primary" }));
    expect(readProjectStateWithSource(paths).source).toBe(paths.stateFile);
    removeStateSource(paths, paths.stateFile);
    expect(readProjectStateWithSource(paths).source).toBe(paths.legacyStateFile);
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("handleDown removes primary state but preserves coexisting legacy state", async () => {
    const dir = mkdtempSync(`${tmpdir()}/down-source-`);
    const stateRoot = mkdtempSync(`${tmpdir()}/down-root-`);
    const paths = resolveProjectPaths({ directory: dir, "state-directory": stateRoot, "task-id": "task" });
    mkdirSync(paths.stateDir, { recursive: true });
    mkdirSync(paths.legacyStateDir, { recursive: true });
    writeFileSync(paths.stateFile, JSON.stringify({ sandboxId: "primary" }));
    writeFileSync(paths.legacyStateFile, JSON.stringify({ sandboxId: "legacy" }));
    const sandbox = { delete: async () => {} };
    await handleDown({ directory: dir, "state-directory": stateRoot, "task-id": "task", client: { get: async () => sandbox } });
    expect(readProjectStateWithSource(paths).source).toBe(paths.legacyStateFile);
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("retains the provisional sandbox id when startup fails and --keep is set", async () => {
    const calls = [];
    const adapter = runAdapter(calls);
    adapter.handleUp = async () => { const error = new Error("start failed"); error.sandboxId = "sandbox-start-fail"; throw error; };
    const result = await runSandboxCtl(["--json", "--keep", "run", "--", "false"], { adapter });
    expect(result).toMatchObject({ ok: false, sandboxId: "sandbox-start-fail", retained: true });
    expect(result.nextActions.join(" ")).toMatch(/--sandbox 'run-/);
  });
});
