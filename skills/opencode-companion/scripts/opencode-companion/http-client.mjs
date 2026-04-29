import { HEALTH_TIMEOUT_MS } from "./constants.mjs";
import { firstNonEmptyLine } from "./text-utils.mjs";

export function buildScopedUrl(baseUrl, pathname, directory) {
  const url = new URL(pathname, baseUrl);
  if (directory) {
    url.searchParams.set("directory", directory);
  }
  return url;
}

export function buildHeaders(directory, extra = {}) {
  const headers = new Headers(extra);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }
  return headers;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const externalSignal = options.signal;

  if ((!timeoutMs || timeoutMs <= 0) && !externalSignal) {
    return await fetch(url, options);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  let timer = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", forwardAbort);
    }
  }
}

export function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

export function parseJsonMaybe(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function makeHttpError(method, url, response, bodyText) {
  const detail = firstNonEmptyLine(bodyText) || `HTTP ${response.status}`;
  return new Error(`${method} ${url.pathname} failed with ${response.status}: ${detail}`);
}

export async function requestJson(baseUrl, pathname, { method = "GET", directory, body, timeoutMs, signal } = {}) {
  const url = buildScopedUrl(baseUrl, pathname, directory);
  const headers = buildHeaders(directory, {
    accept: "application/json"
  });
  let payload;
  if (body != null) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      body: payload,
      signal
    },
    timeoutMs
  );
  const text = await response.text();
  if (!response.ok) {
    throw makeHttpError(method, url, response, text);
  }
  return parseJsonMaybe(text);
}

export async function openEventStream(baseUrl, directory, signal) {
  const url = buildScopedUrl(baseUrl, "/event", directory);
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(directory, {
      accept: "text/event-stream"
    }),
    signal
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw makeHttpError("GET", url, response, bodyText);
  }
  if (!response.body) {
    throw new Error("OpenCode returned no response body for the event stream endpoint.");
  }
  return response;
}

export async function checkHealth(baseUrl) {
  try {
    const response = await fetchWithTimeout(new URL("/global/health", baseUrl), {
      headers: { accept: "application/json" }
    });
    return response.ok;
  } catch {
    return false;
  }
}
