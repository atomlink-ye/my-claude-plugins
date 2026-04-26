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

function delegatedCompanionEnv(binDir) {
  return {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    OPENCODE_FORCE_QUIESCENCE_TIMEOUT_MS: "80",
    OPENCODE_STATUS_POLL_INTERVAL_MS: "10",
    OPENCODE_SETTLING_CHECK_INTERVAL_MS: "10"
  };
}

function installDelegatedPromptScenario(server, {
  rootText = "Delegating to @explorer...",
  childSummary = "@explorer finished",
  nestedChildSummary = null,
  childSlug = "explorer-child",
  nestedChildSlug = "explorer-grandchild",
  childTerminalStatus = "idle",
  nestedChildTerminalStatus = "idle"
} = {}) {
  const promptRoute = "POST /session/:id/prompt_async";
  server.setResponse(promptRoute, async (ctx) => {
    const sessionId = String(ctx.params.id);
    const session = ctx.scope.sessionsById.get(sessionId);
    const userMessageId = `msg_user_${String(++ctx.scope.counter)}`;
    const assistantMessageId = `msg_assistant_${String(++ctx.scope.counter)}`;
    const childSessionId = `ses_child_${String(++ctx.scope.counter)}`;
    const promptText = String(ctx.body?.parts?.[0]?.text ?? "").trim();
    const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];

    messages.push(
      {
        info: { id: userMessageId, sessionID: sessionId, role: "user" },
        parts: [{ type: "text", text: promptText, id: "prt_user" }]
      },
      {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: rootText, id: "prt_delegate" }]
      }
    );
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "busy";
    session.summary = rootText;
    session.updatedAt = new Date().toISOString();

    const childSession = {
      id: childSessionId,
      slug: childSlug,
      parentID: sessionId,
      status: nestedChildSummary ? "busy" : childTerminalStatus,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      directory: ctx.directory,
      summary: childSummary
    };
    ctx.scope.sessions.unshift(childSession);
    ctx.scope.sessionsById.set(childSessionId, childSession);
    ctx.scope.messagesBySessionId.set(childSessionId, []);

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
        partID: "prt_delegate",
        field: "text",
        delta: rootText
      }
    });
    ctx.pushEvent({
      type: "session.status",
      properties: {
        sessionID: childSessionId,
        status: { type: "busy" }
      }
    });

    if (nestedChildSummary) {
      const nestedChildSessionId = `ses_grandchild_${String(++ctx.scope.counter)}`;
      const nestedChildSession = {
        id: nestedChildSessionId,
        slug: nestedChildSlug,
        parentID: childSessionId,
        status: nestedChildTerminalStatus,
        createdAt: new Date(Date.now() - 500).toISOString(),
        updatedAt: new Date().toISOString(),
        directory: ctx.directory,
        summary: nestedChildSummary
      };
      ctx.scope.sessions.unshift(nestedChildSession);
      ctx.scope.sessionsById.set(nestedChildSessionId, nestedChildSession);
      ctx.scope.messagesBySessionId.set(nestedChildSessionId, []);
      ctx.pushEvent({
        type: "session.status",
        properties: {
          sessionID: nestedChildSessionId,
          status: { type: "busy" }
        }
      });
      if (nestedChildTerminalStatus === "failed") {
        ctx.pushEvent({
          type: "session.error",
          properties: {
            sessionID: nestedChildSessionId,
            message: "nested child failed"
          }
        });
      } else {
        ctx.pushEvent({
          type: "session.idle",
          properties: {
            sessionID: nestedChildSessionId
          }
        });
      }
      if (childTerminalStatus === "failed") {
        ctx.pushEvent({
          type: "session.error",
          properties: {
            sessionID: childSessionId,
            message: "child failed"
          }
        });
      } else {
        ctx.pushEvent({
          type: "session.idle",
          properties: {
            sessionID: childSessionId
          }
        });
        childSession.status = childTerminalStatus;
        childSession.updatedAt = new Date().toISOString();
      }
    } else if (childTerminalStatus === "failed") {
      ctx.pushEvent({
        type: "session.error",
        properties: {
          sessionID: childSessionId,
          message: "child failed"
        }
      });
      childSession.status = "failed";
      childSession.updatedAt = new Date().toISOString();
    } else {
      ctx.pushEvent({
        type: "session.idle",
        properties: {
          sessionID: childSessionId
        }
      });
    }

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: rootText, id: "prt_delegate" }]
      }
    };
  });

  return () => {
    server.setResponse(promptRoute, null);
  };
}

function installQuietRootPromptScenario(server, {
  rootText = "quiet root response"
} = {}) {
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
        parts: [{ type: "text", text: rootText, id: "prt_root" }]
      }
    );
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "busy";
    session.summary = rootText;
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
        partID: "prt_root",
        field: "text",
        delta: rootText
      }
    });

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: rootText, id: "prt_root" }]
      }
    };
  });

  return () => {
    server.setResponse(promptRoute, null);
  };
}

function installTransportAcceptedPromptScenario(server, {
  rootText = "request accepted after transport timeout",
  settleDelayMs = 120,
  finalStatus = "idle"
} = {}) {
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
        parts: [{ type: "text", text: rootText, id: "prt_transport" }]
      }
    );
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "busy";
    session.summary = rootText;
    session.updatedAt = new Date().toISOString();

    ctx.pushEvent({
      type: "session.status",
      properties: {
        sessionID: sessionId,
        status: { type: "busy" }
      }
    });

    const timer = setTimeout(() => {
      session.status = finalStatus;
      session.updatedAt = new Date().toISOString();
      ctx.pushEvent({
        type: finalStatus === "failed" ? "session.error" : "session.idle",
        properties: {
          sessionID: sessionId,
          ...(finalStatus === "failed" ? { message: "transport accepted scenario failed" } : {})
        }
      });
    }, settleDelayMs);
    timer.unref?.();

    await ctx.wait(settleDelayMs + 80);
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: rootText, id: "prt_transport" }]
      }
    };
  });

  return () => {
    server.setResponse(promptRoute, null);
  };
}

function installTransportClosedDelegatedScenario(server, {
  rootText = "Delegating despite an early stream close...",
  childSummary = "explorer finished after transport closed",
  childSlug = "explorer-after-stream-close"
} = {}) {
  const promptRoute = "POST /session/:id/prompt_async";
  const eventRoute = "GET /event";

  server.setResponse(eventRoute, async () => ({
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    body: ""
  }));

  server.setResponse(promptRoute, async (ctx) => {
    const sessionId = String(ctx.params.id);
    const session = ctx.scope.sessionsById.get(sessionId);
    const childSessionId = `ses_child_${String(++ctx.scope.counter)}`;
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
        parts: [{ type: "text", text: rootText, id: "prt_delegate" }]
      }
    );
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "busy";
    session.summary = rootText;
    session.updatedAt = new Date().toISOString();

    const childSession = {
      id: childSessionId,
      slug: childSlug,
      parentID: sessionId,
      status: "idle",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      directory: ctx.directory,
      summary: childSummary
    };
    ctx.scope.sessions.unshift(childSession);
    ctx.scope.sessionsById.set(childSessionId, childSession);
    ctx.scope.messagesBySessionId.set(childSessionId, []);

    await ctx.wait(60);
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: rootText, id: "prt_delegate" }]
      }
    };
  });

  return () => {
    server.setResponse(promptRoute, null);
    server.setResponse(eventRoute, null);
  };
}

describe("mock serve integration tests", () => {
  test("serve status reports the managed serve port without spawning a probe serve", async () => {
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

    const result = await spawnCompanion(["serve", "status", "--server-directory", workspace], {
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

  test("serve status without managed state reports none and does not spawn serve", async () => {
    const workspace = tempWorkspace("opencode-check-none-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });

    const result = await spawnCompanion(["serve", "status", "--server-directory", workspace], {
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

  test("serve start reuses healthy mock server state without spawning serve", async () => {
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

    const result = await spawnCompanion(["serve", "start", "--server-directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`reused existing process on ${url}`);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  test("serve start rejects an unavailable requested port before spawning serve", async () => {
    const workspace = tempWorkspace("opencode-port-unavailable-");
    const markerFile = path.join(workspace, "serve-invocations.log");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir, { markerFile });

    const occupiedServer = net.createServer();
    await new Promise((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
    const address = occupiedServer.address();
    const occupiedPort = typeof address === "object" && address ? address.port : null;

    try {
      const result = await spawnCompanion(["serve", "start", "--server-directory", workspace, "--port", String(occupiedPort)], {
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

  test("session new in foreground creates a session, streams output, and exits 0", async () => {
    const workspace = tempWorkspace("opencode-task-foreground-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "write a hello world function"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock response");
    expect(result.stdout).toContain("Session ID:");
  });

  test("session new in foreground finishes even if the idle event is missing", async () => {
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
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "finish without idle event"], {
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

  test("session new exits non-zero when the session reaches a failed terminal state", async () => {
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
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "surface a failed session"], {
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

  test("session new reports delegated settling as informational instead of an error", async () => {
    const workspace = tempWorkspace("opencode-delegated-foreground-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installDelegatedPromptScenario(server);

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "delegate this task"
      ], {
        cwd: workspace,
        env: delegatedCompanionEnv(binDir),
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Finished (settled after delegated activity)");
      expect(result.stdout).toContain("Status: delegated");
      expect(result.stdout).toContain("Delegation to subagents is normal");
      expect(result.stdout).toContain("session status");
      expect(result.stdout).toContain("session attach");
      expect(result.stdout).not.toContain("Status: busy");
    } finally {
      restorePromptRoute();
    }
  });

  test("background delegated jobs stay non-failed and avoid misleading error output", async () => {
    const workspace = tempWorkspace("opencode-delegated-background-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installDelegatedPromptScenario(server);

    try {
      const startResult = await spawnCompanion([
        "session",
        "new",
        "--background",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "delegate this background task"
      ], {
        cwd: workspace,
        env: delegatedCompanionEnv(binDir),
        timeoutMs: 10000
      });

      expect(startResult.exitCode).toBe(0);
      const jobId = startResult.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
      expect(jobId).toBeTruthy();

      const delegatedStatus = await waitFor(async () => {
        const status = await spawnCompanion([
          "job",
          "status",
          jobId,
          "--directory",
          workspace,
          "--server-directory",
          workspace
        ], {
          cwd: workspace,
          env: {
            PATH: `${binDir}:${process.env.PATH || ""}`
          },
          timeoutMs: 10000
        });
        return status.stdout.includes("| status | delegated |") ? status : null;
      }, { description: "background delegated job to settle informationally", timeoutMs: 10000, intervalMs: 50 });

      expect(delegatedStatus.stdout).toContain("| status | delegated |");
      expect(delegatedStatus.stdout).not.toContain("| status | failed |");

      const result = await spawnCompanion([
        "job",
        "result",
        jobId,
        "--directory",
        workspace,
        "--server-directory",
        workspace
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: delegated");
      expect(result.stdout).toContain("Delegation to subagents is normal");
      expect(result.stdout).not.toContain("Error:");
    } finally {
      restorePromptRoute();
    }
  });

  test("session status renders a two-level delegated hierarchy without misreporting failure", async () => {
    const workspace = tempWorkspace("opencode-delegated-two-level-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installDelegatedPromptScenario(server, {
      rootText: "Root delegated to @manager...",
      childSummary: "manager lane finished",
      nestedChildSummary: "explorer leaf finished",
      childSlug: "manager-lane",
      nestedChildSlug: "explorer-leaf"
    });

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "delegate across two layers"
      ], {
        cwd: workspace,
        env: delegatedCompanionEnv(binDir),
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: delegated");
      const sessionId = result.stdout.match(/Session ID: (.+)/)?.[1]?.trim();
      expect(sessionId).toBeTruthy();

      const status = await spawnCompanion([
        "session",
        "status",
        sessionId,
        "--directory",
        workspace,
        "--server-directory",
        workspace
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("## Session Hierarchy");
      expect(status.stdout).toContain("Root delegated to @manager...");
      expect(status.stdout).toContain("manager lane finished");
      expect(status.stdout).toContain("explorer leaf finished");
      expect(status.stdout).toContain("descendant count | 2");
      expect(status.stdout).toContain("root");
      expect(status.stdout).toContain("child");
      expect(status.stdout).not.toContain("| hierarchy verdict | failed |");
    } finally {
      restorePromptRoute();
    }
  });

  test("delegated fallback fails when a descendant session fails", async () => {
    const workspace = tempWorkspace("opencode-delegated-descendant-failed-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installDelegatedPromptScenario(server, {
      rootText: "Root delegated to @manager...",
      childSummary: "manager lane failed",
      nestedChildSummary: "explorer leaf failed",
      childSlug: "manager-lane",
      nestedChildSlug: "explorer-leaf",
      childTerminalStatus: "failed",
      nestedChildTerminalStatus: "failed"
    });

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "delegate into a failing subtree"
      ], {
        cwd: workspace,
        env: delegatedCompanionEnv(binDir),
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Status: failed");
      expect(result.stdout).not.toContain("Status: delegated");
      expect(result.stderr).toContain("descendant session status failed");
    } finally {
      restorePromptRoute();
    }
  });

  test("quiet non-delegated sessions still settle after bounded quiescence", async () => {
    const workspace = tempWorkspace("opencode-quiet-root-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installQuietRootPromptScenario(server, {
      rootText: "root became quiet"
    });

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "be quiet after first response"
      ], {
        cwd: workspace,
        env: {
          ...delegatedCompanionEnv(binDir),
          OPENCODE_QUIESCENCE_TIMEOUT_MS: "80"
        },
        timeoutMs: 4000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: completed");
      expect(result.stdout).toContain("Wrapper completion: quiescence");
      expect(result.stdout).toContain("Root session raw status: busy");
      expect(result.stdout).not.toContain("Delegation to subagents is normal");
    } finally {
      restorePromptRoute();
    }
  });

  test("delegated sessions still settle cleanly when the event stream closes before a terminal root status", async () => {
    const workspace = tempWorkspace("opencode-stream-close-delegated-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restoreRoutes = installTransportClosedDelegatedScenario(server);

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "delegate after early stream close"
      ], {
        cwd: workspace,
        env: {
          ...delegatedCompanionEnv(binDir),
          OPENCODE_STREAM_CLOSE_GRACE_MS: "80"
        },
        timeoutMs: 4000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: delegated");
      expect(result.stdout).toContain("Wrapper completion: delegated_settled");
      expect(result.stdout).toContain("Hierarchy verdict: quiet_delegated");
      expect(result.stdout).toContain("Recommended action: session_status_or_attach");
      expect(result.stderr).toContain("Event stream closed before a terminal root status");
      expect(result.stderr).not.toContain("event stream ended before session completion");
    } finally {
      restoreRoutes();
    }
  });

  test("prompt submit transport timeouts fall back to session monitoring when OpenCode accepts the work", async () => {
    const workspace = tempWorkspace("opencode-prompt-timeout-recover-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restoreRoutes = installTransportAcceptedPromptScenario(server);

    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "recover after prompt submit timeout"
      ], {
        cwd: workspace,
        env: {
          ...delegatedCompanionEnv(binDir),
          OPENCODE_PROMPT_SUBMIT_TIMEOUT_MS: "40"
        },
        timeoutMs: 2000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: completed");
      expect(result.stderr).toContain("Prompt submission timed out");
      expect(result.stderr).toContain("checking session state in case OpenCode accepted the work");
      expect(result.stderr).not.toContain("aborted the task request before it completed");
    } finally {
      restoreRoutes();
    }
  });

  test("session new --background reports started in background, then job status and result complete", async () => {
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

    const startResult = await spawnCompanion(["session", "new", "--background", "--directory", workspace, "--server-directory", workspace, "--", "background job"], {
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
      const status = await spawnCompanion(["job", "status", jobId, "--directory", workspace], {
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
      const status = await spawnCompanion(["job", "status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return status.stdout.includes("completed") ? status.stdout : null;
    }, { description: "background job to complete", timeoutMs: 15000 });

    expect(completedStatus).toContain("completed");

    const result = await spawnCompanion(["job", "result", jobId, "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock response");
  });

  test("job cancel stops a background task and status shows cancelled", async () => {
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

    const startResult = await spawnCompanion(["session", "new", "--background", "--directory", workspace, "--server-directory", workspace, "--", "cancel me"], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    const jobId = startResult.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
    expect(jobId).toBeTruthy();

    await waitFor(async () => {
      const status = await spawnCompanion(["job", "status", jobId, "--directory", workspace], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });
      return status.stdout.includes("queued") || status.stdout.includes("running") ? status.stdout : null;
    }, { description: "background job to become cancellable", timeoutMs: 10000 });

    const cancelResult = await spawnCompanion(["job", "cancel", jobId, "--directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    expect(cancelResult.exitCode).toBe(0);
    expect(cancelResult.stdout).toContain(`Cancelled background job ${jobId}.`);

    const status = await waitFor(async () => {
      const nextStatus = await spawnCompanion(["job", "status", jobId, "--directory", workspace], {
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

    const initialTask = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "create a finished session"], {
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
    const attachResult = await spawnCompanion(["session", "attach", sessionId, "--directory", workspace, "--server-directory", workspace], {
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
