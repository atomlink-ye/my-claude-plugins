import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { handleExec } from "../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs";

describe("Daytona session exec streaming", () => {
  it("streams interleaved stdout/stderr before the remote command completes and preserves exit 7", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sandbox-exec-stream-"));
    const stateDirectory = path.join(directory, "state");
    const oldOut = process.stdout.write;
    const oldErr = process.stderr.write;
    const stdout = [];
    const stderr = [];
    const calls = [];
    let completed = false;
    try {
      mkdirSync(path.join(directory, ".daytona"), { recursive: true });
      writeFileSync(path.join(directory, ".daytona", "state.json"), JSON.stringify({
        sandboxId: "sandbox-stream-1",
        taskId: "demo",
        remoteWorkspacePath: "/workspace/demo",
      }));
      const processApi = {
        executeCommand: async () => ({ stdout: "/home/daytona\n", exitCode: 0 }),
        createSession: async (sessionId) => { calls.push(["createSession", sessionId]); },
        executeSessionCommand: async (sessionId, request) => {
          calls.push(["executeSessionCommand", sessionId, request]);
          expect(completed).toBe(false);
          return { cmdId: "cmd-1" };
        },
        getSessionCommandLogs: async (sessionId, cmdId, onStdout, onStderr) => {
          calls.push(["logs", sessionId, cmdId]);
          onStdout("out-1\n");
          await new Promise((resolve) => setTimeout(resolve, 5));
          onStderr("err-1\n");
          onStdout("out-2\n");
        },
        getSessionCommand: async (sessionId, cmdId) => {
          calls.push(["poll", sessionId, cmdId]);
          if (calls.filter(([name]) => name === "poll").length < 2) return { exitCode: undefined };
          completed = true;
          return { exitCode: 7 };
        },
        deleteSession: async (sessionId) => { calls.push(["deleteSession", sessionId]); },
      };
      const client = { get: async () => ({ id: "sandbox-stream-1", state: "started", process: processApi }) };
      process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
      process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };

      const result = await handleExec({
        client,
        directory,
        "state-directory": stateDirectory,
        "task-id": "demo",
        cwd: "/workspace/demo",
      }, ["printf", "hello"]);

      expect(result.exitCode).toBe(7);
      expect(stdout.join("")).toBe("out-1\nout-2\n");
      expect(stderr.join("")).toBe("err-1\n");
      expect(calls.map(([name]) => name)).toEqual(expect.arrayContaining(["createSession", "executeSessionCommand", "logs", "poll", "deleteSession"]));
      expect(calls.find(([name]) => name === "executeSessionCommand")[2]).toMatchObject({ runAsync: true });
      expect(completed).toBe(true);
    } finally {
      process.stdout.write = oldOut;
      process.stderr.write = oldErr;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("buffers synchronous fallback output and tees a local artifact set", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sandbox-exec-fallback-"));
    const stateDirectory = path.join(directory, "state");
    const artifacts = path.join(directory, "artifacts");
    const oldOut = process.stdout.write;
    const oldErr = process.stderr.write;
    const writes = [];
    try {
      mkdirSync(path.join(directory, ".daytona"), { recursive: true });
      writeFileSync(path.join(directory, ".daytona", "state.json"), JSON.stringify({ sandboxId: "sandbox-fallback-1", taskId: "demo", remoteWorkspacePath: "/workspace/demo" }));
      let execution = 0;
      const client = {
        get: async () => ({ id: "sandbox-fallback-1", state: "started", process: {
          executeCommand: async () => {
            execution += 1;
            return execution === 1 ? { stdout: "/home/daytona\n", exitCode: 0 } : { stdout: "buffered out\n", stderr: "buffered err\n", exitCode: 125 };
          },
        } }),
      };
      process.stdout.write = (chunk) => { writes.push(["stdout", String(chunk)]); return true; };
      process.stderr.write = (chunk) => { writes.push(["stderr", String(chunk)]); return true; };
      const result = await handleExec({ client, directory, "state-directory": stateDirectory, "task-id": "demo", json: true, artifacts }, ["false"]);
      expect(result).toMatchObject({ exitCode: 125, stdout: "buffered out\n", stderr: "buffered err\n", warning: "Output was buffered because streaming is unavailable" });
      expect(writes).toEqual([]);
      expect(readFileSync(path.join(artifacts, "stdout.txt"), "utf8")).toBe("buffered out\n");
      expect(readFileSync(path.join(artifacts, "stderr.txt"), "utf8")).toBe("buffered err\n");
      expect(readFileSync(path.join(artifacts, "exit-code.txt"), "utf8")).toBe("125\n");
      expect(JSON.parse(readFileSync(path.join(artifacts, "manifest.json"), "utf8"))).not.toHaveProperty("env");
    } finally {
      process.stdout.write = oldOut;
      process.stderr.write = oldErr;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps session transport failures to 125 while redacting configured secrets", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sandbox-exec-control-"));
    const stateDirectory = path.join(directory, "state");
    const originalToken = process.env.DAYTONA_API_KEY;
    try {
      mkdirSync(path.join(directory, ".daytona"), { recursive: true });
      writeFileSync(path.join(directory, ".daytona", "state.json"), JSON.stringify({ sandboxId: "sandbox-control-1", taskId: "demo", remoteWorkspacePath: "/workspace/demo" }));
      process.env.DAYTONA_API_KEY = "control-secret-token";
      const client = { get: async () => ({ id: "sandbox-control-1", state: "started", process: {
        executeCommand: async () => ({ stdout: "/home/daytona\n", exitCode: 0 }),
        createSession: async () => { throw new Error("transport failed control-secret-token"); },
        executeSessionCommand: async () => ({ cmdId: "unused" }),
        getSessionCommandLogs: async () => {},
        getSessionCommand: async () => ({ exitCode: 0 }),
        deleteSession: async () => {},
      } }) };
      const result = await handleExec({ client, directory, "state-directory": stateDirectory, "task-id": "demo", json: true }, ["false"]);
      expect(result.exitCode).toBe(125);
      expect(result.error).toContain("transport failed");
      expect(result.error).not.toContain("control-secret-token");
    } finally {
      if (originalToken === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = originalToken;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a remote run exit code through the real CLI process", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "sandbox-run-fixture-"));
    const fixture = path.join(fixtureDir, "adapter.mjs");
    const cli = path.resolve(process.cwd(), "skills/sandbox-ctl/scripts/sandbox-ctl.mjs");
    writeFileSync(fixture, `
      export function parseArgs(argv) { return { command: argv[0], options: {}, positionals: [], passthrough: argv.slice(1) }; }
      export async function handleUp() { return { sandboxId: "fixture-sandbox" }; }
      export async function handlePush() { return { ok: true }; }
      export async function handleExec() { process.stdout.write("fixture stdout"); process.stderr.write("fixture stderr"); return { ok: false, exitCode: 7 }; }
      export async function handlePull() { return { ok: true }; }
      export async function handleDown() { return { ok: true }; }
    `);
    try {
      const child = spawnSync(process.execPath, [cli, "--json", "run", "--", "false"], {
        encoding: "utf8",
        env: { ...process.env, SANDBOX_CTL_ADAPTER_MODULE: fixture },
      });
      expect(child.status).toBe(7);
      expect(JSON.parse(child.stdout)).toMatchObject({ command: "run", exitCode: 7, stdout: "fixture stdout", stderr: "fixture stderr" });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("reports a redacted actionable control failure once in human CLI mode", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "sandbox-exec-human-failure-"));
    const fixture = path.join(fixtureDir, "adapter.mjs");
    const cli = path.resolve(process.cwd(), "skills/sandbox-ctl/scripts/sandbox-ctl.mjs");
    writeFileSync(fixture, `
      export function parseArgs(argv) { return { command: argv[0], options: {}, positionals: [], passthrough: argv.slice(1) }; }
      export async function handleExec() { return { exitCode: 125, warning: "Output was buffered because streaming is unavailable", error: "transport failed control-secret-token; retry sandbox-ctl exec" }; }
    `);
    try {
      const child = spawnSync(process.execPath, [cli, "exec", "--", "false"], {
        encoding: "utf8",
        env: { ...process.env, DAYTONA_API_KEY: "control-secret-token", SANDBOX_CTL_ADAPTER_MODULE: fixture },
      });
      expect(child.status).toBe(125);
      expect(child.stderr).toContain("Output was buffered because streaming is unavailable");
      expect(child.stderr).toContain("transport failed");
      expect(child.stderr).toContain("retry sandbox-ctl exec");
      expect(child.stderr).not.toContain("control-secret-token");
      expect(child.stderr.match(/transport failed/g)).toHaveLength(1);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
