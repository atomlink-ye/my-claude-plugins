import fs from "node:fs";
import net from "node:net";
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
  test("check reports the managed serve port without spawning a probe serve", async () => {
    const workspace = tempWorkspace("opencode-check-managed-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });
    const { port } = await startMockServer();

    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const result = await spawnCompanion(["check", "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Managed serve port: ${port}`);
    expect(result.stdout).toContain("Managed serve health: healthy");
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  test("check without managed state reports none and does not spawn serve", async () => {
    const workspace = tempWorkspace("opencode-check-none-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });

    const result = await spawnCompanion(["check", "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Managed serve port: none");
    expect(result.stdout).toContain("Managed serve health: not reachable");
    expect(fs.existsSync(markerFile)).toBe(false);
  });

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

  test("ensure-serve rejects an unavailable requested port before spawning serve", async () => {
    const workspace = tempWorkspace("opencode-port-unavailable-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });

    const occupiedServer = net.createServer();
    await new Promise((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
    const address = occupiedServer.address();
    const occupiedPort = typeof address === "object" && address ? address.port : null;

    try {
      const result = await spawnCompanion(["ensure-serve", "--directory", workspace, "--port", String(occupiedPort)], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        }
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Port ${occupiedPort} is unavailable.`);
      expect(fs.existsSync(markerFile)).toBe(false);
    } finally {
      await new Promise((resolve, reject) => occupiedServer.close((error) => (error ? reject(error) : resolve())));
    }
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

  test("task in foreground finishes even if the idle event is missing", async () => {
    const workspace = tempWorkspace("opencode-task-no-idle-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const promptRoute = "POST /session/:id/prompt_async";
    server.setResponse(promptRoute, async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const userMessageId = `msg_user_${String(++ctx.scope.counter)}`;
      const assistantMessageId = `msg_assistant_${String(++ctx.scope.counter)}`;
      const promptText = String(ctx.body?.parts?.[0]?.text ?? "").trim();
      const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];

      messages.push(
        {
          info: { id: userMessageId, sessionID: sessionId, role: "user" },
          parts: [{ type: "text", text: promptText, id: "prt_user" }]
        },
        {
          info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
          parts: [{ type: "text", text: "mock response without idle", id: "prt1" }]
        }
      );
      ctx.scope.messagesBySessionId.set(sessionId, messages);

      session.status = "idle";
      session.summary = "mock response without idle";
      session.updatedAt = new Date().toISOString();

      ctx.pushEvent({
        type: "session.status",
        properties: {
          sessionID: sessionId,
          status: { type: "busy" }
        }
      });
      ctx.pushEvent({
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: "prt1",
          field: "text",
          delta: "mock response without idle"
        }
      });

      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: {
          info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
          parts: [{ type: "text", text: "mock response without idle", id: "prt1" }]
        }
      };
    });

    try {
      const startedAt = Date.now();
      const result = await spawnCompanion(["task", "--directory", workspace, "--server-directory", workspace, "--", "finish without idle event"], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("mock response without idle");
      expect(result.stdout).toContain("Session ID:");
      expect(elapsedMs).toBeLessThan(6000);
    } finally {
      server.setResponse(promptRoute, null);
    }
  });

  test("task exits non-zero when the session reaches a failed terminal state", async () => {
    const workspace = tempWorkspace("opencode-task-failed-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const promptRoute = "POST /session/:id/prompt_async";
    server.setResponse(promptRoute, async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const userMessageId = `msg_user_${String(++ctx.scope.counter)}`;
      const assistantMessageId = `msg_assistant_${String(++ctx.scope.counter)}`;
      const promptText = String(ctx.body?.parts?.[0]?.text ?? "").trim();
      const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];

      messages.push(
        {
          info: { id: userMessageId, sessionID: sessionId, role: "user" },
          parts: [{ type: "text", text: promptText, id: "prt_user" }]
        },
        {
          info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
          parts: [{ type: "text", text: "mock failure output", id: "prt_fail" }]
        }
      );
      ctx.scope.messagesBySessionId.set(sessionId, messages);

      session.status = "failed";
      session.summary = "mock failure output";
      session.updatedAt = new Date().toISOString();

      ctx.pushEvent({
        type: "session.status",
        properties: {
          sessionID: sessionId,
          status: { type: "busy" }
        }
      });
      ctx.pushEvent({
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: "prt_fail",
          field: "text",
          delta: "mock failure output"
        }
      });

      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: {
          info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
          parts: [{ type: "text", text: "mock failure output", id: "prt_fail" }]
        }
      };
    });

    try {
      const result = await spawnCompanion(["task", "--directory", workspace, "--server-directory", workspace, "--", "surface a failed session"], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("mock failure output");
      expect(result.stdout).toContain("Status: failed");
    } finally {
      server.setResponse(promptRoute, null);
    }
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

    await waitFor(async () => {
      const status = await spawnCompanion(["status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return status.stdout.includes("queued") || status.stdout.includes("running") ? status.stdout : null;
    }, { description: "background job to become cancellable", timeoutMs: 10000 });

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

  test("attach returns quickly for an already-idle session", async () => {
    const workspace = tempWorkspace("opencode-attach-idle-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const initialTask = await spawnCompanion(["task", "--directory", workspace, "--server-directory", workspace, "--", "create a finished session"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });
    expect(initialTask.exitCode).toBe(0);

    const sessionId = initialTask.stdout.match(/Session ID: (.+)/)?.[1]?.trim();
    expect(sessionId).toBeTruthy();

    const startedAt = Date.now();
    const attachResult = await spawnCompanion(["attach", sessionId, "--directory", workspace, "--server-directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });
    const elapsedMs = Date.now() - startedAt;

    expect(attachResult.exitCode).toBe(0);
    expect(attachResult.stdout).toContain("mock response");
    expect(attachResult.stdout).toContain(`Session ID: ${sessionId}`);
    expect(elapsedMs).toBeLessThan(5000);
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
