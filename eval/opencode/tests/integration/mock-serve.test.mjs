import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMockOpenCodeServer } from "../mocks/opencode-server.mjs";
import {
  makeTempDir,
  removeDir,
  runGit,
  spawnCompanion,
  waitFor,
  writeFakeOpencodeBinary,
  writeJson
} from "./test-helpers.mjs";

const tempDirs = [];
let server = null;
let serverInfo = null;

beforeEach(() => {
  server = createMockOpenCodeServer();
});

afterEach(async () => {
  if (serverInfo) {
    await serverInfo.stop();
    serverInfo = null;
  }

  while (tempDirs.length > 0) {
    removeDir(tempDirs.pop());
  }
});

function tempWorkspace(prefix = "opencode-mock-") {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function startMockServer() {
  serverInfo = await server.start();
  return serverInfo;
}

async function makeGitWorkspace() {
  const dir = tempWorkspace("opencode-review-");
  await runGit(["init"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "OpenCode Test"], dir);
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n", "utf8");
  await runGit(["add", "notes.txt"], dir);
  await runGit(["commit", "-m", "init"], dir);
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\nworld\n", "utf8");
  return dir;
}

describe("mock serve integration tests", () => {
  test("ensure-serve reuses healthy mock server state without spawning serve", async () => {
    const workspace = tempWorkspace("opencode-ensure-serve-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });
    const { port, url } = await startMockServer();

    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const result = await spawnCompanion(["ensure-serve", "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`reused existing process on ${url}`);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  test("task in foreground creates a session, streams output, and exits 0", async () => {
    const workspace = tempWorkspace("opencode-task-foreground-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const result = await spawnCompanion(["task", "--directory", workspace, "--server-directory", workspace, "--", "write a hello world function"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock response");
    expect(result.stdout).toContain("Session ID:");
  });

  test("task --background reports started in background, then status and result complete", async () => {
    const workspace = tempWorkspace("opencode-task-background-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      await ctx.wait(350);
      return await ctx.next();
    });

    const startResult = await spawnCompanion(["task", "--background", "--directory", workspace, "--server-directory", workspace, "--", "background job"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(startResult.exitCode).toBe(0);
    const match = startResult.stdout.match(/started in background as (task-[a-f0-9-]+)/i);
    expect(match).not.toBeNull();
    const jobId = match[1];

    const runningStatus = await waitFor(async () => {
      const status = await spawnCompanion(["status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return status.stdout.includes("running") ? status.stdout : null;
    }, { description: "background job to become running", timeoutMs: 10000 });

    expect(runningStatus).toContain(jobId);

    const completedStatus = await waitFor(async () => {
      const status = await spawnCompanion(["status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return status.stdout.includes("completed") ? status.stdout : null;
    }, { description: "background job to complete", timeoutMs: 15000 });

    expect(completedStatus).toContain("completed");

    const result = await spawnCompanion(["result", jobId, "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock response");
  });

  test("cancel stops a background task and status shows cancelled", async () => {
    const workspace = tempWorkspace("opencode-task-cancel-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      await ctx.wait(1000);
      return await ctx.next();
    });

    const startResult = await spawnCompanion(["task", "--background", "--directory", workspace, "--server-directory", workspace, "--", "cancel me"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    const jobId = startResult.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
    expect(jobId).toBeTruthy();

    const cancelResult = await spawnCompanion(["cancel", jobId, "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    expect(cancelResult.exitCode).toBe(0);
    expect(cancelResult.stdout).toContain(`Cancelled background job ${jobId}.`);

    const status = await waitFor(async () => {
      const nextStatus = await spawnCompanion(["status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return nextStatus.stdout.includes("cancelled") ? nextStatus.stdout : null;
    }, { description: "background job to be cancelled", timeoutMs: 15000 });

    expect(status).toContain("cancelled");
  });

  test("review with working-tree scope sends the git diff to the mock serve", async () => {
    const workspace = await makeGitWorkspace();
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    let capturedPrompt = "";
    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      capturedPrompt = String(ctx.body?.parts?.[0]?.text ?? "");
      return await ctx.next();
    });

    const result = await spawnCompanion(["review", "--scope", "working-tree", "--directory", workspace, "--server-directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 20000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock response");
    expect(capturedPrompt).toContain("Review scope: working-tree");
    expect(capturedPrompt).toContain("Git status:");
    expect(capturedPrompt).toContain("+world");
  });
});
