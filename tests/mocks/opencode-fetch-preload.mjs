import fs from "node:fs";
import path from "node:path";

const registry = (() => {
  try {
    return JSON.parse(process.env.OPENCODE_MOCK_FETCH_REGISTRY || "{}");
  } catch {
    return {};
  }
})();

const originalFetch = globalThis.fetch?.bind(globalThis);
const encoder = new TextEncoder();
let requestCounter = 0;
let requestSequence = 0;

function isAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function getStateDirForUrl(url) {
  const parsed = new URL(String(url));
  return registry[String(parsed.port)] || null;
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function waitForFile(filePath, signal, intervalMs = 15) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(isAbortError());
      return;
    }

    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        reject(isAbortError());
        return;
      }
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(filePath);
      }
    }, intervalMs);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(timer);
          reject(isAbortError());
        },
        { once: true }
      );
    }
  });
}

async function readResponseRecord(responseFile, signal) {
  await waitForFile(responseFile, signal);
  return JSON.parse(fs.readFileSync(responseFile, "utf8"));
}

async function createPollingStream({ eventsFile, cursor, initialEvents, signal }) {
  let offset = Number(cursor) || 0;
  let closed = false;
  let timer = null;
  const initialChunks = [...(Array.isArray(initialEvents) ? initialEvents : [])];

  return new ReadableStream({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(encoder.encode(String(chunk)));
      }
      timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        if (signal?.aborted) {
          closed = true;
          clearInterval(timer);
          controller.error(isAbortError());
          return;
        }
        try {
          if (!fs.existsSync(eventsFile)) {
            return;
          }
          const stats = fs.statSync(eventsFile);
          if (stats.size <= offset) {
            return;
          }
          const fd = fs.openSync(eventsFile, "r");
          try {
            const length = stats.size - offset;
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, offset);
            offset = stats.size;
            controller.enqueue(buffer);
          } finally {
            fs.closeSync(fd);
          }
        } catch (error) {
          closed = true;
          clearInterval(timer);
          controller.error(error);
        }
      }, 25);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            closed = true;
            clearInterval(timer);
            controller.error(isAbortError());
          },
          { once: true }
        );
      }
    },
    cancel() {
      closed = true;
      if (timer) {
        clearInterval(timer);
      }
    }
  });
}

if (originalFetch) {
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? "");
    const stateDir = getStateDirForUrl(requestUrl);
    if (!stateDir) {
      return await originalFetch(input, init);
    }

    const parsedUrl = new URL(requestUrl);
    const requestsDir = path.join(stateDir, "requests");
    const responsesDir = path.join(stateDir, "responses");
    const requestId = `${process.pid}-${Date.now()}-${++requestCounter}`;
    const requestFile = path.join(requestsDir, `${requestId}.json`);
    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const headers = Object.fromEntries(new Headers(init.headers ?? (typeof input !== "string" && input.headers ? input.headers : undefined) ?? {}).entries());
    const method = String(init.method ?? (typeof input !== "string" && input.method) ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? null : String(init.body);
    const requestRecord = {
      id: requestId,
      createdAt: Date.now(),
      directory: parsedUrl.searchParams.get("directory") || headers["x-opencode-directory"] || "__default__",
      headers,
      method,
      sequence: ++requestSequence,
      url: requestUrl,
      body
    };

    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(responsesDir, { recursive: true });
    writeJsonAtomic(requestFile, requestRecord);

    const signal = init.signal ?? (typeof input !== "string" && input.signal ? input.signal : null);
    const responseRecord = await readResponseRecord(responseFile, signal);

    if (responseRecord.error) {
      throw new Error(responseRecord.error);
    }

    if (responseRecord.stream) {
      const stream = await createPollingStream({
        cursor: responseRecord.cursor,
        eventsFile: responseRecord.eventsFile,
        initialEvents: responseRecord.initialEvents,
        signal
      });
      return new Response(stream, {
        headers: responseRecord.headers,
        status: responseRecord.status
      });
    }

    return new Response(responseRecord.bodyText ?? "", {
      headers: responseRecord.headers,
      status: responseRecord.status
    });
  };
}
