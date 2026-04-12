import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const activeServersByPort = new Map();
let nextSyntheticPort = 47000;

function nowIso() {
  return new Date().toISOString();
}

function parseJsonBody(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return {};
  }
  return JSON.parse(trimmed);
}

function toSse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function splitRoute(route) {
  const [method, ...pathParts] = String(route ?? "").trim().split(/\s+/);
  return {
    method: method?.toUpperCase() ?? "GET",
    pattern: pathParts.join(" ")
  };
}

function compilePattern(pattern) {
  const names = [];
  const segments = String(pattern ?? "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });

  return {
    regex: new RegExp(`^/${segments.join("/")}/?$`),
    names
  };
}

function createRouteTable() {
  const routes = [];

  const upsert = (route, handler) => {
    const { method, pattern } = splitRoute(route);
    const existingIndex = routes.findIndex((entry) => entry.route === route);
    const compiled = compilePattern(pattern);
    const entry = { route, method, pattern, handler, ...compiled };
    if (existingIndex >= 0) {
      routes[existingIndex] = entry;
    } else {
      routes.unshift(entry);
    }
  };

  const match = (method, pathname) => {
    for (const entry of routes) {
      if (entry.method !== method.toUpperCase()) {
        continue;
      }
      const captured = pathname.match(entry.regex);
      if (!captured) {
        continue;
      }
      const params = {};
      for (let index = 0; index < entry.names.length; index += 1) {
        params[entry.names[index]] = decodeURIComponent(captured[index + 1]);
      }
      return { entry, params };
    }
    return null;
  };

  return { routes, upsert, match };
}

function safeKey(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function extractSessionId(pathname) {
  const match = String(pathname ?? "").match(/^\/session\/([^/]+)\/(message|prompt_async|abort)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createScope(directory, stateDir) {
  const directoryKey = safeKey(directory);
  const eventsFile = path.join(stateDir, "events", `${directoryKey}.log`);
  ensureDir(path.dirname(eventsFile));
  if (!fs.existsSync(eventsFile)) {
    fs.writeFileSync(eventsFile, "", "utf8");
  }

  return {
    counter: 0,
    directory,
    directoryKey,
    eventsFile,
    eventStreamOpen: false,
    messagesBySessionId: new Map(),
    pendingEventLines: [],
    sessions: [],
    sessionsById: new Map()
  };
}

export function getMockOpenCodeServerRegistrySnapshot() {
  return Object.fromEntries([...activeServersByPort.entries()].map(([port, server]) => [String(port), server.stateDir]));
}

export function createMockOpenCodeServer() {
  const routeTable = createRouteTable();
  const scopes = new Map();
  let stateDir = null;
  let pollTimer = null;
  let port = null;
  let stopped = false;
  let started = false;
  let processingRequests = false;

  const getScope = (directory) => {
    const scopeKey = String(directory || "__default__");
    if (!scopes.has(scopeKey)) {
      if (!stateDir) {
        throw new Error("Mock OpenCode server has not been started.");
      }
      scopes.set(scopeKey, createScope(scopeKey, stateDir));
    }
    return scopes.get(scopeKey);
  };

  const pushEvent = (directory, event) => {
    const scope = getScope(directory);
    const line = toSse(event);
    if (!scope.eventStreamOpen) {
      scope.pendingEventLines.push(line);
      return;
    }
    fs.appendFileSync(scope.eventsFile, line, "utf8");
  };

  const defaultDispatch = async ({ method, pathname, body, directory, params, scope }) => {
    const sessionId = params.id ?? extractSessionId(pathname);

    if (method === "GET" && pathname === "/global/health") {
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: { healthy: true, version: "mock" } };
    }

    if (method === "POST" && pathname === "/session") {
      const sessionId = `ses_test_${String(++scope.counter)}`;
      const session = {
        id: sessionId,
        slug: "test-session",
        status: "idle",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        directory
      };
      scope.sessions.unshift(session);
      scope.sessionsById.set(sessionId, session);
      scope.messagesBySessionId.set(sessionId, []);
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: session };
    }

    if (method === "GET" && pathname === "/session") {
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: [...scope.sessions] };
    }

    if (method === "GET" && pathname === "/event") {
      scope.eventStreamOpen = true;
      const initialEvents = scope.pendingEventLines.splice(0, scope.pendingEventLines.length);
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        },
        stream: true,
        eventsFile: scope.eventsFile,
        cursor: fs.existsSync(scope.eventsFile) ? fs.statSync(scope.eventsFile).size : 0,
        initialEvents
      };
    }

    if (method === "GET" && pathname === "/global/event") {
      scope.eventStreamOpen = true;
      const initialEvents = scope.pendingEventLines.splice(0, scope.pendingEventLines.length);
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        },
        stream: true,
        eventsFile: scope.eventsFile,
        cursor: fs.existsSync(scope.eventsFile) ? fs.statSync(scope.eventsFile).size : 0,
        initialEvents
      };
    }

    if (method === "POST" && pathname === `/session/${encodeURIComponent(sessionId ?? "")}/abort`) {
      const session = sessionId ? scope.sessionsById.get(sessionId) : null;
      if (session) {
        session.status = "aborted";
        session.updatedAt = nowIso();
      }
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: true };
    }

    if (method === "GET" && pathname === `/session/${encodeURIComponent(sessionId ?? "")}/message`) {
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: sessionId ? scope.messagesBySessionId.get(sessionId) ?? [] : []
      };
    }

    if (method === "POST" && (pathname === `/session/${encodeURIComponent(sessionId ?? "")}/message` || pathname === `/session/${encodeURIComponent(sessionId ?? "")}/prompt_async`)) {
      const session = sessionId ? scope.sessionsById.get(sessionId) : null;
      if (!session) {
        return { status: 404, headers: { "content-type": "application/json; charset=utf-8" }, body: { error: "Unknown session" } };
      }

      const userMessageId = `msg_user_${String(++scope.counter)}`;
      const assistantMessageId = `msg_assistant_${String(++scope.counter)}`;
      const promptText = String(body?.parts?.[0]?.text ?? body?.text ?? body?.prompt ?? "").trim();
      const messages = scope.messagesBySessionId.get(sessionId) ?? [];
      const userMessage = {
        info: { id: userMessageId, sessionID: sessionId, role: "user" },
        parts: [{ type: "text", text: promptText, id: "prt_user" }]
      };
      const assistantMessage = {
        info: { id: assistantMessageId, sessionID: sessionId, role: "assistant" },
        parts: [{ type: "text", text: "mock response", id: "prt1" }]
      };

      messages.push(userMessage, assistantMessage);
      scope.messagesBySessionId.set(sessionId, messages);

      session.status = "idle";
      session.summary = "mock response";
      session.updatedAt = nowIso();

      pushEvent(directory, {
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: { role: "user" }
        }
      });
      pushEvent(directory, {
        type: "session.status",
        properties: {
          sessionID: sessionId,
          status: { type: "busy" }
        }
      });
      pushEvent(directory, {
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: "prt1",
          field: "text",
          delta: "mock "
        }
      });
      pushEvent(directory, {
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: "prt1",
          field: "text",
          delta: "response"
        }
      });
      pushEvent(directory, {
        type: "session.idle",
        properties: {
          sessionID: sessionId
        }
      });

      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: {
          info: {
            id: assistantMessageId,
            sessionID: sessionId,
            role: "assistant"
          },
          parts: [{ type: "text", text: "mock response", id: "prt1" }]
        }
      };
    }

    return null;
  };

  const dispatchRequest = async (request) => {
    const url = new URL(String(request.url), "http://127.0.0.1");
    const method = String(request.method ?? "GET").toUpperCase();
    const directory = String(url.searchParams.get("directory") || request.directory || request.headers?.["x-opencode-directory"] || "__default__");
    const scope = getScope(directory);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const body = request.body == null ? {} : typeof request.body === "string" ? parseJsonBody(request.body) : request.body;
    const routeMatch = routeTable.match(method, pathname);
    const params = extractSessionId(pathname) ? { id: extractSessionId(pathname) } : {};

    if (routeMatch) {
      for (let index = 0; index < routeMatch.entry.names.length; index += 1) {
        params[routeMatch.entry.names[index]] = routeMatch.params[routeMatch.entry.names[index]];
      }
      const ctx = {
        body,
        directory,
        method,
        pathname,
        params,
        pushEvent: (event) => pushEvent(directory, event),
        scope,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        next: async () => await defaultDispatch({ body, directory, method, pathname, params, scope })
      };
      const result = await routeMatch.entry.handler(ctx);
      if (result !== undefined) {
        return result;
      }
    }

    return await defaultDispatch({ body, directory, method, pathname, params, scope });
  };

  const processQueuedRequests = async () => {
    if (processingRequests) {
      return;
    }
    processingRequests = true;
    try {
      if (!stateDir) {
        return;
      }

      const requestsDir = path.join(stateDir, "requests");
      const responsesDir = path.join(stateDir, "responses");
      ensureDir(requestsDir);
      ensureDir(responsesDir);

      const requestFiles = fs
        .readdirSync(requestsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(requestsDir, file))
        .sort((left, right) => {
          const leftRecord = readJsonFile(left, { sequence: 0, createdAt: 0 });
          const rightRecord = readJsonFile(right, { sequence: 0, createdAt: 0 });
          const leftSeq = Number(leftRecord?.sequence ?? 0);
          const rightSeq = Number(rightRecord?.sequence ?? 0);
          if (leftSeq !== rightSeq) {
            return leftSeq - rightSeq;
          }
          const leftValue = Number(leftRecord?.createdAt ?? 0);
          const rightValue = Number(rightRecord?.createdAt ?? 0);
          return leftValue - rightValue;
        });

      for (const requestFile of requestFiles) {
        const requestRecord = readJsonFile(requestFile, null);
        if (!requestRecord) {
          continue;
        }
        const responseFile = path.join(responsesDir, `${requestRecord.id}.json`);
        if (fs.existsSync(responseFile)) {
          fs.rmSync(requestFile, { force: true });
          continue;
        }

        try {
          const response = await dispatchRequest(requestRecord);
          const normalized =
            response && typeof response === "object" && response.stream
              ? {
                  status: response.status ?? 200,
                  headers: response.headers ?? {},
                  stream: true,
                  eventsFile: response.eventsFile,
                  cursor: response.cursor ?? 0,
                  initialEvents: response.initialEvents ?? []
                }
              : {
                  status: response?.status ?? 200,
                  headers: response?.headers ?? { "content-type": "application/json; charset=utf-8" },
                  bodyText:
                    typeof response?.body === "string"
                      ? response.body
                      : response?.body != null
                        ? `${JSON.stringify(response.body)}\n`
                        : ""
                };
          writeJsonAtomic(responseFile, normalized);
          fs.rmSync(requestFile, { force: true });
        } catch (error) {
          writeJsonAtomic(responseFile, {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
            error: error instanceof Error ? error.message : String(error)
          });
          fs.rmSync(requestFile, { force: true });
        }
      }
    } finally {
      processingRequests = false;
    }
  };

  const start = async () => {
    if (started) {
      throw new Error("Mock OpenCode server already started.");
    }
    started = true;
    port = nextSyntheticPort += 1;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-mock-${port}-`));
    ensureDir(path.join(stateDir, "requests"));
    ensureDir(path.join(stateDir, "responses"));
    ensureDir(path.join(stateDir, "events"));
    activeServersByPort.set(port, { stateDir });
    pollTimer = setInterval(() => {
      void processQueuedRequests();
    }, 25);
    pollTimer.unref?.();

    return {
      port,
      url: `http://127.0.0.1:${port}`,
      stateDir,
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        activeServersByPort.delete(port);
        try {
          fs.rmSync(stateDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors in tests.
        }
      }
    };
  };

  const setResponse = (route, handler) => {
    if (!handler) {
      const index = routeTable.routes.findIndex((entry) => entry.route === route);
      if (index >= 0) {
        routeTable.routes.splice(index, 1);
      }
      return;
    }
    routeTable.upsert(route, handler);
  };

  return {
    get stateDir() {
      return stateDir;
    },
    dispatchRequest,
    pushEvent,
    setResponse,
    start
  };
}

const defaultServer = createMockOpenCodeServer();

export async function start() {
  return await defaultServer.start();
}

export function setResponse(route, handler) {
  defaultServer.setResponse(route, handler);
}
