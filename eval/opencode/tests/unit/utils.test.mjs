import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySessionOutcome,
  deriveResultStatus,
  formatDuration,
  generateJobId,
  isBusySessionStatus,
  isFailedTerminalSessionStatus,
  isSameRealPath,
  isSuccessfulTerminalSessionStatus,
  summarizePrompt
} from "../../../../skills/opencode-companion/scripts/opencode-companion.mjs";

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
    expect(deriveResultStatus({ terminalStatus: "busy", abortedBySignal: false, completionMode: "delegated_settled" })).toBe("delegated");
    expect(deriveResultStatus({ terminalStatus: "busy", abortedBySignal: false, completionMode: "quiescence" })).toBe("completed");
    expect(deriveResultStatus({ terminalStatus: "busy", abortedBySignal: false, completionMode: "descendant_failed" })).toBe("failed");
    expect(deriveResultStatus({ terminalStatus: "failed", abortedBySignal: false })).toBe("failed");
    expect(deriveResultStatus({ terminalStatus: "cancelled", abortedBySignal: false })).toBe("cancelled");
    expect(deriveResultStatus({ terminalStatus: "idle", abortedBySignal: true })).toBe("aborted");
  });

  it("classifies delegated outcomes with hierarchy and recommended-action metadata", () => {
    expect(
      classifySessionOutcome({
        sessionId: "ses_demo",
        terminalStatus: "busy",
        rawSessionStatus: "busy",
        abortedBySignal: false,
        completionMode: "delegated_settled",
        hierarchyVerdict: "quiet_delegated"
      })
    ).toEqual({
      status: "delegated",
      completionMode: "delegated_settled",
      rawSessionStatus: "busy",
      hierarchyVerdict: "quiet_delegated",
      recommendedAction: "session_status_or_attach"
    });
  });

  it("treats symlinked and real script paths as the same path", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "opencode-companion-path-"));
    const realFile = path.join(tempRoot, "real-script.mjs");
    const symlinkFile = path.join(tempRoot, "linked-script.mjs");

    try {
      writeFileSync(realFile, "export {};\n");
      symlinkSync(realFile, symlinkFile);

      expect(isSameRealPath(realFile, symlinkFile)).toBe(true);
      expect(isSameRealPath(symlinkFile, realFile)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
