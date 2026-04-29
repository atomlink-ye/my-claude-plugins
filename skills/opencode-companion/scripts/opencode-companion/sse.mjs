export function parseSseBlock(block) {
  const normalized = block.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1).replace(/^\s/, "") : "";
    if (field === "data") {
      dataLines.push(rawValue);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { done: true, payload: "[DONE]" };
  }
  try {
    return {
      done: false,
      payload: JSON.parse(data)
    };
  } catch {
    return null;
  }
}

export async function streamSseResponse(stream, onEvent, { abortSignal } = {}) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let aborted = false;

  const cancelReader = async () => {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors during shutdown.
    }
  };

  const abortListener = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      abortListener();
    } else {
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          if (event.done) {
            await cancelReader();
            return { streamClosed: true };
          }
          const result = await onEvent(event);
          if (result?.done || result?.aborted) {
            await cancelReader();
            return result?.aborted ? { aborted: true } : { streamClosed: true };
          }
        }
        if (aborted) {
          return { aborted: true };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");
    if (!aborted && buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) {
        if (event.done) {
          await cancelReader();
          return { streamClosed: true };
        }
        const result = await onEvent(event);
        if (result?.done || result?.aborted) {
          await cancelReader();
          return result?.aborted ? { aborted: true } : { streamClosed: true };
        }
      }
    }

    if (aborted) {
      return { aborted: true };
    }

    return { streamClosed: true };
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }
}
