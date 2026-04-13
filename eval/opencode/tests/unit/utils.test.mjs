import { describe, expect, it } from "vitest";
import {
  deriveResultStatus,
  formatDuration,
  generateJobId,
  isBusySessionStatus,
  isFailedTerminalSessionStatus,
  isSuccessfulTerminalSessionStatus,
  summarizePrompt
} from "../../../../plugins/opencode/scripts/opencode-companion.mjs";

describe("utility helpers", () => {
  it("generates job ids that match the expected pattern", () => {
    expect(generateJobId()).toMatch(/^task-[0-9a-f]{6}-[0-9a-f]{6}$/);
  });

  it("formats short, medium, and long durations", () => {
    expect(formatDuration("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:05.000Z")).toBe("5s");
    expect(formatDuration("2024-01-01T00:00:00.000Z", "2024-01-01T00:01:30.000Z")).toBe("1m 30s");
    expect(formatDuration("2024-01-01T00:00:00.000Z", "2024-01-01T02:05:10.000Z")).toBe("2h 5m");
  });

  it("summarizes long prompts to 120 characters with an ellipsis", () => {
    const prompt = "abcdefghijklmnopqrstuvwxyz ".repeat(8);
    const normalized = prompt.trim().replace(/\s+/g, " ");

    expect(summarizePrompt(prompt)).toBe(`${normalized.slice(0, 120)}...`);
  });

  it("classifies session states consistently", () => {
    expect(isSuccessfulTerminalSessionStatus("idle")).toBe(true);
    expect(isFailedTerminalSessionStatus("failed")).toBe(true);
    expect(isBusySessionStatus("active")).toBe(true);
    expect(isBusySessionStatus("running")).toBe(true);
    expect(isBusySessionStatus("busy")).toBe(true);
    expect(isBusySessionStatus("idle")).toBe(false);
  });

  it("derives failed result statuses without collapsing them to completed", () => {
    expect(deriveResultStatus({ terminalStatus: "idle", abortedBySignal: false })).toBe("completed");
    expect(deriveResultStatus({ terminalStatus: "failed", abortedBySignal: false })).toBe("failed");
    expect(deriveResultStatus({ terminalStatus: "cancelled", abortedBySignal: false })).toBe("cancelled");
    expect(deriveResultStatus({ terminalStatus: "idle", abortedBySignal: true })).toBe("aborted");
  });
});
