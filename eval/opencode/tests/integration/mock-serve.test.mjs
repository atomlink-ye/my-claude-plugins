import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatReadableTimestamp } from "../../../../skills/opencode-companion/scripts/opencode-companion.mjs";
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
    OPENCODE_HIERARCHY_PENDING_GRACE_MS: "80",
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

function installRichLoggingPromptScenario(server, {
  reasoningText = "Plan:\n- inspect logs\n- run tests\n",
  commandText = "pnpm vitest run eval/opencode/tests/unit/render.test.mjs",
  toolOutputText = "1 file passed",
  finalText = "Done with logging review."
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
        parts: [
          { type: "reasoning", text: reasoningText, id: "prt_reasoning" },
          {
            type: "tool",
            id: "prt_tool_bash",
            tool: { name: "bash" },
            state: {
              status: "completed",
              input: { command: commandText },
              output: { text: toolOutputText },
              result: { ok: true }
            }
          },
          { type: "text", text: finalText, id: "prt_text" }
        ]
      }
    );
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "idle";
    session.summary = finalText;
    session.updatedAt = new Date().toISOString();

    ctx.pushEvent({
      type: "session.status",
      properties: {
        sessionID: sessionId,
        status: { type: "busy" }
      }
    });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: "prt_reasoning",
        part: {
          id: "prt_reasoning",
          type: "reasoning"
        }
      }
    });
    ctx.pushEvent({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: "prt_reasoning",
        field: "text",
        delta: reasoningText
      }
    });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: "prt_tool_bash",
        part: {
          id: "prt_tool_bash",
          type: "tool",
          tool: { name: "bash" },
          state: {
            status: "completed",
            input: { command: commandText },
            output: { text: toolOutputText },
            result: { ok: true }
          }
        }
      }
    });
    ctx.pushEvent({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: "prt_text",
        field: "text",
        delta: finalText
      }
    });
    ctx.pushEvent({
      type: "session.idle",
      properties: {
        sessionID: sessionId
      }
    });

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [
          { type: "reasoning", text: reasoningText, id: "prt_reasoning" },
          {
            type: "tool",
            id: "prt_tool_bash",
            tool: { name: "bash" },
            state: {
              status: "completed",
              input: { command: commandText },
              output: { text: toolOutputText },
              result: { ok: true }
            }
          },
          { type: "text", text: finalText, id: "prt_text" }
        ]
      }
    };
  });

  return () => {
    server.setResponse(promptRoute, null);
  };
}

function installNativeTaskChildScenario(server, { orphan = false, settleDelayMs = 180 } = {}) {
  const promptRoute = "POST /session/:id/prompt_async";
  server.setResponse(promptRoute, async (ctx) => {
    const sessionId = String(ctx.params.id);
    const session = ctx.scope.sessionsById.get(sessionId);
    const childSessionId = `ses_native_child_${String(++ctx.scope.counter)}`;
    const assistantMessageId = `msg_assistant_${String(++ctx.scope.counter)}`;
    const taskPartId = "prt_task_native";
    const childSession = {
      id: childSessionId,
      slug: orphan ? "orphan-native-child" : "native-child",
      ...(orphan ? {} : { parentID: sessionId }),
      status: "busy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      directory: ctx.directory,
      summary: "native child running"
    };
    ctx.scope.sessions.unshift(childSession);
    ctx.scope.sessionsById.set(childSessionId, childSession);
    ctx.scope.messagesBySessionId.set(childSessionId, []);
    const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];
    messages.push({
      info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
      parts: [{
        id: taskPartId,
        type: "tool",
        tool: "task",
        state: { status: "running", input: { subagent_type: "explorer", description: "inspect slowly" } }
      }]
    });
    ctx.scope.messagesBySessionId.set(sessionId, messages);
    session.status = "busy";
    session.summary = "root launched native task";
    session.updatedAt = new Date().toISOString();
    ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: taskPartId,
        part: { id: taskPartId, type: "tool", tool: "task", state: { status: "running", input: { subagent_type: "explorer" } } }
      }
    });
    ctx.pushEvent({ type: "session.status", properties: { sessionID: childSessionId, status: { type: "busy" } } });

    const timer = setTimeout(() => {
      childSession.status = "idle";
      childSession.summary = "native child finished";
      childSession.updatedAt = new Date().toISOString();
      messages[0].parts[0].state = { status: "completed", output: orphan ? `task_id: ${childSessionId}` : "done" };
      ctx.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: taskPartId,
          part: { id: taskPartId, type: "tool", tool: "task", state: { status: "completed", output: orphan ? `task_id: ${childSessionId}` : "done" } }
        }
      });
      ctx.pushEvent({ type: "session.idle", properties: { sessionID: childSessionId } });
    }, settleDelayMs);
    timer.unref?.();

    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" }, parts: messages[0].parts } };
  });
  return () => server.setResponse(promptRoute, null);
}

function installRichTraceScenario(server, { settleDelayMs = 30 } = {}) {
  const promptRoute = "POST /session/:id/prompt_async";
  server.setResponse(promptRoute, async (ctx) => {
    const sessionId = String(ctx.params.id);
    const session = ctx.scope.sessionsById.get(sessionId);
    const childSessionId = `ses_trace_child_${String(++ctx.scope.counter)}`;
    const assistantMessageId = `msg_assistant_${String(++ctx.scope.counter)}`;
    const reasoningPartId = "prt_reasoning_trace";
    const bashPartId = "prt_bash_trace";
    const taskPartId = "prt_task_trace";
    const reasoningText = "Inspect current session logs\nCompare delegated child activity";
    const bashCommand = "git status --short\npnpm test eval/opencode/tests/unit/render.test.mjs";
    const childSession = {
      id: childSessionId,
      slug: "trace-child",
      parentID: sessionId,
      status: "busy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      directory: ctx.directory,
      summary: "child trace collecting workspace details"
    };
    ctx.scope.sessions.unshift(childSession);
    ctx.scope.sessionsById.set(childSessionId, childSession);
    ctx.scope.messagesBySessionId.set(childSessionId, []);

    const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];
    messages.push({
      info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
      parts: [
        {
          id: reasoningPartId,
          type: "reasoning",
          text: reasoningText
        },
        {
          id: bashPartId,
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: bashCommand },
            output: {
              exitCode: 0,
              stdout: " M skills/opencode-companion/scripts/opencode-companion.mjs\n"
            }
          }
        },
        {
          id: taskPartId,
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "explorer", description: "inspect repo structure" },
            output: `task_id: ${childSessionId}`
          }
        },
        {
          id: "prt_text_trace",
          type: "text",
          text: "Trace collection complete."
        }
      ]
    });
    ctx.scope.messagesBySessionId.set(sessionId, messages);

    session.status = "busy";
    session.summary = "trace collection running";
    session.updatedAt = new Date().toISOString();

    ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: reasoningPartId,
        part: { id: reasoningPartId, type: "reasoning", text: reasoningText }
      }
    });
    ctx.pushEvent({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: reasoningPartId,
        field: "text",
        delta: "Inspect current session logs\n"
      }
    });
    ctx.pushEvent({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: reasoningPartId,
        field: "text",
        delta: "Compare delegated child activity"
      }
    });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: bashPartId,
        part: {
          id: bashPartId,
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: bashCommand } }
        }
      }
    });
    ctx.pushEvent({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: taskPartId,
        part: {
          id: taskPartId,
          type: "tool",
          tool: "task",
          state: { status: "running", input: { subagent_type: "explorer", description: "inspect repo structure" } }
        }
      }
    });
    ctx.pushEvent({ type: "session.status", properties: { sessionID: childSessionId, status: { type: "busy" } } });

    const timer = setTimeout(() => {
      childSession.status = "idle";
      childSession.summary = "child trace finished";
      childSession.updatedAt = new Date().toISOString();
      session.status = "idle";
      session.updatedAt = new Date().toISOString();
      ctx.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: bashPartId,
          part: {
            id: bashPartId,
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: bashCommand },
              output: {
                exitCode: 0,
                stdout: " M skills/opencode-companion/scripts/opencode-companion.mjs\n"
              }
            }
          }
        }
      });
      ctx.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: taskPartId,
          part: {
            id: taskPartId,
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "explorer", description: "inspect repo structure" },
              output: `task_id: ${childSessionId}`
            }
          }
        }
      });
      ctx.pushEvent({ type: "session.idle", properties: { sessionID: childSessionId } });
      ctx.pushEvent({ type: "session.idle", properties: { sessionID: sessionId } });
    }, settleDelayMs);
    timer.unref?.();

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: messages[0].parts
      }
    };
  });
  return () => server.setResponse(promptRoute, null);
}

function installPendingEventScenario(server, eventType) {
  const promptRoute = "POST /session/:id/prompt_async";
  server.setResponse(promptRoute, async (ctx) => {
    const sessionId = String(ctx.params.id);
    const session = ctx.scope.sessionsById.get(sessionId);
    session.status = "busy";
    session.updatedAt = new Date().toISOString();
    ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
    ctx.pushEvent({ type: eventType, properties: { sessionID: sessionId, id: `${eventType}-1`, text: "Need input" } });
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { info: { id: "msg_pending", sessionID: sessionId, role: "assistant" }, parts: [] } };
  });
  return () => server.setResponse(promptRoute, null);
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
        return status.stdout.includes("Status: delegated") ? status : null;
      }, { description: "background delegated job to settle informationally", timeoutMs: 10000, intervalMs: 50 });

      expect(delegatedStatus.stdout).toContain("Status: delegated");
      expect(delegatedStatus.stdout).not.toContain("Status: failed");

      const result = await spawnCompanion([
        "job",
        "wait",
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
      expect(result.stdout).toContain("Delegating to @explorer...");
      expect(result.stdout).not.toContain("Status: delegated");
      expect(result.stdout).not.toContain("Delegation to subagents is normal");
      expect(result.stdout).not.toContain("## Recent execution trace");
      expect(result.stdout).not.toContain("Error:");

      const quietResult = await spawnCompanion([
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

      expect(quietResult.exitCode).toBe(0);
      expect(quietResult.stdout).toContain("Delegating to @explorer...");
      expect(quietResult.stdout).not.toContain("Status: delegated");
      expect(quietResult.stdout).not.toContain("Delegation to subagents is normal");
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
      expect(status.stdout).toContain("descendant count | 2");
      expect(status.stdout).toContain("root");
      expect(status.stdout).toContain("child");
      expect(status.stdout).not.toContain("| hierarchy verdict | failed |");
    } finally {
      restorePromptRoute();
    }
  });

  test("session status shows last and total token usage when available", async () => {
    const workspace = tempWorkspace("opencode-session-usage-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const sessionId = "ses_usage_demo";
    const createdAt = "2026-04-30T10:24:42.731Z";
    const updatedAt = "2026-04-30T10:52:49.916Z";
    server.setResponse("GET /session", async (ctx) => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: [
        {
          id: sessionId,
          status: "running",
          createdAt,
          updatedAt,
          directory: ctx.directory,
          summary: "token probe",
          lastUsage: {
            InputTokens: 861,
            OutputTokens: 151,
            CachedTokens: 85504,
            CostUsd: "$0.00"
          },
          totalUsage: {
            InputTokens: 1200,
            OutputTokens: 300,
            CachedTokens: 90000,
            CostUsd: "$0.12"
          }
        }
      ]
    }));

    try {
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
      expect(status.stdout).toContain(`| created | ${formatReadableTimestamp(createdAt)} |`);
      expect(status.stdout).toContain(`| updated | ${formatReadableTimestamp(updatedAt)} |`);
      expect(status.stdout).toContain("| last usage | 86,516 total, in 861, out 151, cached 85,504, $0.00 |");
      expect(status.stdout).toContain("| total usage | 91,500 total, in 1,200, out 300, cached 90,000, $0.12 |");
      expect(status.stdout).toContain("| tree | id | parent | raw | observed | updated |");
      expect(status.stdout).not.toContain(createdAt);
      expect(status.stdout).not.toContain(updatedAt);
    } finally {
      server.setResponse("GET /session", null);
    }
  });

  test("session status avoids wait guidance when a completed root only has recently-settled descendants", async () => {
    const workspace = tempWorkspace("opencode-session-finished-guidance-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const sessionId = "ses_finished_root";
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const updatedAt = new Date(Date.now() - 8_000).toISOString();
    const descendantUpdatedAt = new Date(Date.now() - 3_000).toISOString();
    server.setResponse("GET /session", async (ctx) => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: [
        {
          id: sessionId,
          status: "completed",
          createdAt,
          updatedAt,
          directory: ctx.directory,
          summary: "final answer ready"
        },
        {
          id: "ses_finished_child",
          parentID: sessionId,
          status: "unknown",
          createdAt: updatedAt,
          updatedAt: descendantUpdatedAt,
          directory: ctx.directory,
          summary: "child bookkeeping settled"
        }
      ]
    }));

    try {
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
      expect(status.stdout).toContain("| raw status | completed |");
      expect(status.stdout).toContain(
        `| recommended next action | read final result or inspect artifacts; session continue ${sessionId} only if reuse still makes sense |`
      );
      expect(status.stdout).not.toContain(`wait or session attach ${sessionId}`);
    } finally {
      server.setResponse("GET /session", null);
    }
  });

  test("session status avoids wait guidance for a simple recently-finished root when trace shows the last bash tool completed", async () => {
    const workspace = tempWorkspace("opencode-session-trace-finished-guidance-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const sessionId = "ses_trace_finished_root";
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const updatedAt = new Date(Date.now() - 8_000).toISOString();
    server.setResponse("GET /session", async (ctx) => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: [
        {
          id: sessionId,
          status: "unknown",
          createdAt,
          updatedAt,
          directory: ctx.directory,
          summary: "bash command finished"
        }
      ]
    }));
    server.setResponse(`GET /session/${sessionId}/message`, async () => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: [
        {
          info: { id: "msg_trace_finished", sessionID: sessionId, role: "assistant" },
          parts: [
            {
              id: "prt_trace_finished_bash",
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "pnpm exec vitest run eval/opencode/tests/unit/render.test.mjs" },
                output: {
                  exitCode: 0,
                  stdout: "1 file passed"
                }
              }
            }
          ]
        }
      ]
    }));

    try {
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
      expect(status.stdout).toContain("| raw status | unknown |");
      expect(status.stdout).toContain("| observed session status | active_recent |");
      expect(status.stdout).toContain("| hierarchy verdict | active |");
      expect(status.stdout).toContain("bash [completed]");
      expect(status.stdout).toContain(
        `| recommended next action | read final result or inspect artifacts; session continue ${sessionId} only if reuse still makes sense |`
      );
      expect(status.stdout).not.toContain(`wait or session attach ${sessionId}`);
    } finally {
      server.setResponse("GET /session", null);
      server.setResponse(`GET /session/${sessionId}/message`, null);
    }
  });

  test("streaming output and session status expose reasoning, bash traces, and delegated tool activity", async () => {
    const workspace = tempWorkspace("opencode-rich-trace-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restore = installRichTraceScenario(server);
    try {
      const result = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "show rich trace output"
      ], {
        cwd: workspace,
        env: delegatedCompanionEnv(binDir),
        timeoutMs: 10000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Inspect current session logs");
      expect(result.stdout).toContain("Compare delegated child activity");
      expect(result.stdout).toContain("git status --short");
      expect(result.stdout).toContain("inspect repo structure");

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
      expect(status.stdout).toContain("## Recent execution trace");
      expect(status.stdout).toContain("Inspect current session logs");
      expect(status.stdout).toContain("Compare delegated child activity");
      expect(status.stdout).toContain("git status --short");
      expect(status.stdout).toContain("inspect repo structure");
      expect(status.stdout).toContain("ses_trace_child_");
    } finally {
      restore();
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

  test("native task child keeps wait alive after root goes quiet", async () => {
    const workspace = tempWorkspace("opencode-native-child-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const restore = installNativeTaskChildScenario(server, { settleDelayMs: 180 });
    try {
      const startedAt = Date.now();
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "launch native task"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_QUIESCENCE_TIMEOUT_MS: "40" },
        timeoutMs: 5000
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(160);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: delegated");
      expect(result.stdout).toContain("Wrapper completion: delegated_settled");
      expect(result.stderr).not.toContain("Finished (quiescence)");
    } finally {
      restore();
    }
  });

  test("task tool output can attach an orphan child session to monitoring", async () => {
    const workspace = tempWorkspace("opencode-orphan-child-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const restore = installNativeTaskChildScenario(server, { orphan: true, settleDelayMs: 180 });
    try {
      const startedAt = Date.now();
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "launch orphan native task"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_QUIESCENCE_TIMEOUT_MS: "40" },
        timeoutMs: 5000
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(160);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: delegated");
      expect(result.stderr).not.toContain("Finished (quiescence)");
    } finally {
      restore();
    }
  });

  test("shell-launched companion background job keeps wait alive while active", async () => {
    const workspace = tempWorkspace("opencode-shell-background-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const jobId = "task-abc123-def456";
    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const now = new Date().toISOString();
      writeJson(path.join(workspace, ".opencode-jobs.json"), [{ id: jobId, status: "running", pid: process.pid, createdAt: now, updatedAt: now, startedAt: now }]);
      session.status = "busy";
      session.updatedAt = now;
      ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
      ctx.pushEvent({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: "msg_shell", partID: "prt_shell", field: "text", delta: `OpenCode task started in background as ${jobId}.` } });
      const timer = setTimeout(() => writeJson(path.join(workspace, ".opencode-jobs.json"), [{ id: jobId, status: "completed", pid: null, createdAt: now, updatedAt: new Date().toISOString(), startedAt: now, completedAt: new Date().toISOString() }]), 180);
      timer.unref?.();
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { info: { id: "msg_shell", sessionID: sessionId, role: "assistant" }, parts: [{ type: "text", text: `OpenCode task started in background as ${jobId}.`, id: "prt_shell" }] } };
    });
    try {
      const startedAt = Date.now();
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "launch background shell job"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_QUIESCENCE_TIMEOUT_MS: "40" },
        timeoutMs: 5000
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(160);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: completed");
      expect(result.stderr).toContain("Detected active companion background job");
    } finally {
      server.setResponse("POST /session/:id/prompt_async", null);
    }
  });

  test("question.asked returns a pending question-needed result", async () => {
    const workspace = tempWorkspace("opencode-question-needed-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const restore = installPendingEventScenario(server, "question.asked");
    try {
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "ask me"], { cwd: workspace, env: delegatedCompanionEnv(binDir), timeoutMs: 5000 });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Status: question_needed");
      expect(result.stdout).toContain("Recommended action: answer_question");
      expect(result.stdout).not.toContain("Status: completed");
    } finally {
      restore();
    }
  });

  test("permission.asked returns a pending permission-needed result", async () => {
    const workspace = tempWorkspace("opencode-permission-needed-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const restore = installPendingEventScenario(server, "permission.asked");
    try {
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "need permission"], { cwd: workspace, env: delegatedCompanionEnv(binDir), timeoutMs: 5000 });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Status: permission_needed");
      expect(result.stdout).toContain("Recommended action: approve_or_deny_permission");
      expect(result.stdout).not.toContain("Status: completed");
    } finally {
      restore();
    }
  });

  test("pending events from unrelated same-directory sessions do not stop the current wait", async () => {
    const workspace = tempWorkspace("opencode-unrelated-question-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const unrelatedSessionId = `ses_unrelated_${String(++ctx.scope.counter)}`;
      ctx.scope.sessions.unshift({
        id: unrelatedSessionId,
        slug: "unrelated-question",
        status: "busy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        directory: ctx.directory,
        summary: "unrelated session needs input"
      });
      session.status = "busy";
      session.updatedAt = new Date().toISOString();
      ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
      ctx.pushEvent({ type: "question.asked", properties: { sessionID: unrelatedSessionId, id: "question-unrelated", text: "Ignore me" } });
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { info: { id: "msg_current", sessionID: sessionId, role: "assistant" }, parts: [] } };
    });
    try {
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "ignore unrelated question"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_QUIESCENCE_TIMEOUT_MS: "40" },
        timeoutMs: 5000
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: completed");
      expect(result.stdout).not.toContain("question_needed");
    } finally {
      server.setResponse("POST /session/:id/prompt_async", null);
    }
  });

  test("pending events from newly-created child sessions are not missed before polling", async () => {
    const workspace = tempWorkspace("opencode-child-question-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const childSessionId = `ses_child_question_${String(++ctx.scope.counter)}`;
      ctx.scope.sessions.unshift({
        id: childSessionId,
        slug: "child-question",
        parentID: sessionId,
        status: "busy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        directory: ctx.directory,
        summary: "child needs input"
      });
      session.status = "busy";
      session.updatedAt = new Date().toISOString();
      ctx.pushEvent({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
      ctx.pushEvent({ type: "question.asked", properties: { sessionID: childSessionId, id: "question-child", text: "Answer child" } });
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { info: { id: "msg_child_question", sessionID: sessionId, role: "assistant" }, parts: [] } };
    });
    try {
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "child asks question"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_STATUS_POLL_INTERVAL_MS: "10000" },
        timeoutMs: 5000
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Status: question_needed");
      expect(result.stdout).toContain("Recommended action: answer_question");
    } finally {
      server.setResponse("POST /session/:id/prompt_async", null);
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

  test("stream-close reconciliation waits for active background jobs found in message snapshots", async () => {
    const workspace = tempWorkspace("opencode-stream-close-background-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), { pid: process.pid, port, startedAt: new Date().toISOString() });
    const jobId = "task-bcd234-efg567";

    server.setResponse("GET /event", async () => ({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: "" }));
    server.setResponse("POST /session/:id/prompt_async", async (ctx) => {
      const sessionId = String(ctx.params.id);
      const session = ctx.scope.sessionsById.get(sessionId);
      const now = new Date().toISOString();
      writeJson(path.join(workspace, ".opencode-jobs.json"), [{ id: jobId, status: "running", pid: process.pid, createdAt: now, updatedAt: now, startedAt: now }]);
      const messages = ctx.scope.messagesBySessionId.get(sessionId) ?? [];
      messages.push({ info: { id: "msg_stream_bg", sessionID: sessionId, role: "assistant" }, parts: [{ type: "text", id: "prt_stream_bg", text: `OpenCode task started in background as ${jobId}.` }] });
      ctx.scope.messagesBySessionId.set(sessionId, messages);
      session.status = "busy";
      session.summary = "stream closed with background job";
      session.updatedAt = now;
      const timer = setTimeout(() => writeJson(path.join(workspace, ".opencode-jobs.json"), [{ id: jobId, status: "completed", pid: null, createdAt: now, updatedAt: new Date().toISOString(), startedAt: now, completedAt: new Date().toISOString() }]), 180);
      timer.unref?.();
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: messages.at(-1) };
    });

    try {
      const startedAt = Date.now();
      const result = await spawnCompanion(["session", "new", "--directory", workspace, "--server-directory", workspace, "--", "stream close with background"], {
        cwd: workspace,
        env: { ...delegatedCompanionEnv(binDir), OPENCODE_STREAM_CLOSE_GRACE_MS: "80", OPENCODE_QUIESCENCE_TIMEOUT_MS: "40" },
        timeoutMs: 5000
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(160);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Status: completed");
      expect(result.stderr).toContain("Event stream closed before a terminal root status");
      expect(result.stderr).not.toContain("event stream ended before session completion");
    } finally {
      server.setResponse("GET /event", null);
      server.setResponse("POST /session/:id/prompt_async", null);
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

    const artifactRoot = path.join(workspace, ".opencode-companion", "jobs");
    const jobDir = path.join(artifactRoot, jobId);
    expect(fs.existsSync(path.join(artifactRoot, "index.json"))).toBe(true);
    expect(fs.existsSync(jobDir)).toBe(true);
    expect(fs.existsSync(path.join(jobDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(jobDir, "snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(jobDir, "snapshot.md"))).toBe(true);
    expect(fs.existsSync(path.join(jobDir, "compat.log"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".opencode-jobs.json"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, `.opencode-job-${jobId}.log`))).toBe(false);

    const waitResult = await spawnCompanion(["job", "wait", jobId, "--directory", workspace, "--server-directory", workspace], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      timeoutMs: 10000
    });

    expect(waitResult.exitCode).toBe(0);
    expect(waitResult.stdout).toContain("mock response");
    expect(waitResult.stdout).not.toContain("## Recent execution trace");
    expect(waitResult.stdout).not.toContain("OpenCode Job Status");

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

  test("job status is liveness-first by default and verbose restores hierarchy and trace details", async () => {
    const workspace = tempWorkspace("opencode-liveness-status-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installRichLoggingPromptScenario(server, {
      finalText: "Final answer only."
    });

    try {
      const backgroundStart = await spawnCompanion([
        "session",
        "new",
        "--background",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "show me liveness-first status"
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(backgroundStart.exitCode).toBe(0);
      const jobId = backgroundStart.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
      expect(jobId).toBeTruthy();

      const status = await waitFor(async () => {
        const nextStatus = await spawnCompanion([
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
        return nextStatus.stdout.includes("Verdict:") ? nextStatus : null;
      }, { description: "liveness-first status snapshot", timeoutMs: 15000, intervalMs: 50 });

      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Verdict:");
      expect(status.stdout).toContain("Recommended action:");
      expect(status.stdout).toContain("Latest activity:");
      expect(status.stdout).not.toContain("## Recent execution trace");
      expect(status.stdout).not.toContain("pnpm vitest run eval/opencode/tests/unit/render.test.mjs");

      const verboseStatus = await waitFor(async () => {
        const nextStatus = await spawnCompanion([
          "job",
          "status",
          jobId,
          "--verbose",
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
        return nextStatus.stdout.includes("## Session Hierarchy") && nextStatus.stdout.includes("## Recent execution trace")
          ? nextStatus
          : null;
      }, { description: "verbose job status with hierarchy and trace", timeoutMs: 15000, intervalMs: 50 });

      expect(verboseStatus.exitCode).toBe(0);
      expect(verboseStatus.stdout).toContain("## Session Hierarchy");
      expect(verboseStatus.stdout).toContain("## Recent execution trace");
      expect(verboseStatus.stdout).toContain("pnpm vitest run eval/opencode/tests/unit/render.test.mjs");
      expect((verboseStatus.stdout.match(/## Session Hierarchy/g) ?? [])).toHaveLength(1);
      expect((verboseStatus.stdout.match(/## Recent execution trace/g) ?? [])).toHaveLength(1);
      expect(verboseStatus.stdout).not.toContain("Log tail for");

      const waitResult = await spawnCompanion([
        "job",
        "wait",
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

      expect(waitResult.exitCode).toBe(0);
      expect(waitResult.stdout).toContain("Final answer only.");
      expect(waitResult.stdout).not.toContain("Plan:");
      expect(waitResult.stdout).not.toContain("pnpm vitest run eval/opencode/tests/unit/render.test.mjs");
    } finally {
      restorePromptRoute();
    }
  });

  test("artifact root precedence prefers cli flag over env var and env var over default", async () => {
    const workspace = tempWorkspace("opencode-artifact-root-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const cliStart = await spawnCompanion([
      "session",
      "new",
      "--background",
      "--artifact-root",
      ".cli-artifacts",
      "--directory",
      workspace,
      "--server-directory",
      workspace,
      "--",
      "cli root wins"
    ], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`,
        OPENCODE_ARTIFACT_ROOT: ".env-artifacts"
      },
      timeoutMs: 10000
    });

    const cliJobId = cliStart.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
    expect(cliJobId).toBeTruthy();

    await waitFor(async () => {
      const result = await spawnCompanion([
        "job",
        "wait",
        cliJobId,
        "--artifact-root",
        ".cli-artifacts",
        "--directory",
        workspace,
        "--server-directory",
        workspace
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`,
          OPENCODE_ARTIFACT_ROOT: ".env-artifacts"
        },
        timeoutMs: 10000
      });
      return result.exitCode === 0 ? result : null;
    }, { description: "cli artifact-root job completion", timeoutMs: 15000, intervalMs: 50 });

    expect(fs.existsSync(path.join(workspace, ".cli-artifacts", "jobs", cliJobId, "snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".env-artifacts", "jobs", cliJobId, "snapshot.json"))).toBe(false);

    const envStart = await spawnCompanion([
      "session",
      "new",
      "--background",
      "--directory",
      workspace,
      "--server-directory",
      workspace,
      "--",
      "env root wins over default"
    ], {
      cwd: workspace,
      env: {
        PATH: `${binDir}:${process.env.PATH || ""}`,
        OPENCODE_ARTIFACT_ROOT: ".env-only-artifacts"
      },
      timeoutMs: 10000
    });

    const envJobId = envStart.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
    expect(envJobId).toBeTruthy();

    await waitFor(async () => {
      const result = await spawnCompanion([
        "job",
        "wait",
        envJobId,
        "--directory",
        workspace,
        "--server-directory",
        workspace
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`,
          OPENCODE_ARTIFACT_ROOT: ".env-only-artifacts"
        },
        timeoutMs: 10000
      });
      return result.exitCode === 0 ? result : null;
    }, { description: "env artifact-root job completion", timeoutMs: 15000, intervalMs: 50 });

    expect(fs.existsSync(path.join(workspace, ".env-only-artifacts", "jobs", envJobId, "snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".opencode-companion", "jobs", envJobId, "snapshot.json"))).toBe(false);
  });

  test("logging surfaces readable reasoning, bash execution details, and recent trace sections", async () => {
    const workspace = tempWorkspace("opencode-rich-logging-");
    const binDir = path.join(workspace, "bin");
    await writeFakeOpencodeBinary(binDir);
    const { port } = await startMockServer();
    writeJson(path.join(workspace, ".opencode-serve.json"), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    const restorePromptRoute = installRichLoggingPromptScenario(server);

    try {
      const foreground = await spawnCompanion([
        "session",
        "new",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "show me rich logging"
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(foreground.exitCode).toBe(0);
      expect(foreground.stdout).toContain("thinking: Plan: · - inspect logs · - run tests");
      expect(foreground.stdout).toContain("bash [completed]: pnpm vitest run eval/opencode/tests/unit/render.test.mjs");
      expect(foreground.stdout).not.toContain("1 file passed");
      expect(foreground.stdout).not.toContain("output:");
      expect(foreground.stdout).not.toContain("description:");
      expect(foreground.stdout).not.toContain("input:");
      expect(foreground.stdout).not.toContain("[tool: bash]");

      const sessionId = foreground.stdout.match(/Session ID: (.+)/)?.[1]?.trim();
      expect(sessionId).toBeTruthy();

      const sessionStatus = await spawnCompanion([
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

      expect(sessionStatus.exitCode).toBe(0);
      expect(sessionStatus.stdout).toContain("## Recent execution trace");
      expect(sessionStatus.stdout).toContain("- thinking: Plan: · - inspect logs · - run tests");
      expect(sessionStatus.stdout).toContain("- bash [completed]: pnpm vitest run eval/opencode/tests/unit/render.test.mjs");
      expect(sessionStatus.stdout).not.toContain("1 file passed");
      expect(sessionStatus.stdout).not.toContain("output:");
      expect(sessionStatus.stdout).not.toContain("description:");
      expect(sessionStatus.stdout).not.toContain("input:");

      const backgroundStart = await spawnCompanion([
        "session",
        "new",
        "--background",
        "--directory",
        workspace,
        "--server-directory",
        workspace,
        "--",
        "show me rich logging in a background job"
      ], {
        cwd: workspace,
        env: {
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        timeoutMs: 10000
      });

      expect(backgroundStart.exitCode).toBe(0);
      const jobId = backgroundStart.stdout.match(/started in background as (task-[a-f0-9-]+)/i)?.[1];
      expect(jobId).toBeTruthy();

      const jobStatus = await waitFor(async () => {
        const status = await spawnCompanion([
          "job",
          "status",
          jobId,
          "--verbose",
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
        return status.stdout.includes("pnpm vitest run eval/opencode/tests/unit/render.test.mjs") ? status : null;
      }, { description: "background rich logging output to appear in job status", timeoutMs: 15000, intervalMs: 50 });

      expect(jobStatus.exitCode).toBe(0);
      expect(jobStatus.stdout).toContain("## Recent execution trace");
      expect(jobStatus.stdout).toContain("- thinking: Plan: · - inspect logs · - run tests");
      expect(jobStatus.stdout).toContain("- bash [completed]: pnpm vitest run eval/opencode/tests/unit/render.test.mjs");
      expect(jobStatus.stdout).not.toContain("1 file passed");
      expect(jobStatus.stdout).not.toContain("output:");
    } finally {
      restorePromptRoute();
    }
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
