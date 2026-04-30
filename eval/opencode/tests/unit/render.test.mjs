import { describe, expect, it } from "vitest";
import {
  buildSessionListView,
  buildSingleSessionView,
  formatReadableTimestamp,
  renderBackgroundTaskStart,
  renderTaskSummary
} from "../../../../skills/opencode-companion/scripts/opencode-companion.mjs";

describe("renderBackgroundTaskStart", () => {
  it("renders the basic case", () => {
    expect(renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs")).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode-companion.mjs' job status task-abc123-def456\n"
    );
  });

  it("wraps a path with spaces in single quotes", () => {
    expect(
      renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode companion.mjs", "/tmp/my project")
    ).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode companion.mjs' job status task-abc123-def456 --directory '/tmp/my project'\n"
    );
  });

  it("escapes single quotes in paths", () => {
    expect(
      renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs", "/tmp/dir's project")
    ).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode-companion.mjs' job status task-abc123-def456 --directory '/tmp/dir'\\''s project'\n"
    );
  });

  it("omits the directory flag when directory is null or undefined", () => {
    expect(renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs", null)).not.toContain(
      "--directory"
    );
    expect(
      renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs", undefined)
    ).not.toContain("--directory");
  });
});

describe("renderTaskSummary", () => {
  it("renders delegated guidance without leaking the raw busy status as the main result", () => {
    const summary = renderTaskSummary({
      session_id: "ses_demo",
      directory: "/tmp/demo",
      status: "delegated",
      completion_mode: "delegated_settled",
      raw_session_status: "busy",
      hierarchy_verdict: "quiet_delegated",
      recommended_action: "session_status_or_attach"
    });

    expect(summary).toContain("Status: delegated");
    expect(summary).toContain("Wrapper completion: delegated_settled");
    expect(summary).toContain("Root session raw status: busy");
    expect(summary).toContain("Hierarchy verdict: quiet_delegated");
    expect(summary).toContain("Recommended action: session_status_or_attach");
    expect(summary).toContain("Delegation to subagents is normal");
    expect(summary).toContain("session status ses_demo");
    expect(summary).toContain("session attach ses_demo");
    expect(summary).not.toContain("Status: busy\n");
  });
});

describe("session usage rendering", () => {
  it("renders last and total usage in the session list", () => {
    const createdAt = "2026-04-30T10:24:42.731Z";
    const updatedAt = "2026-04-30T10:52:49.916Z";
    const view = buildSessionListView("/tmp/demo", [
      {
        id: "ses_demo",
        status: "busy",
        createdAt,
        updatedAt,
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
    ]);

    expect(view).toContain("last usage | total usage");
    expect(view).toContain(formatReadableTimestamp(createdAt));
    expect(view).toContain(formatReadableTimestamp(updatedAt));
    expect(view).not.toContain(createdAt);
    expect(view).not.toContain(updatedAt);
    expect(view).toContain("86,516 total, in 861, out 151, cached 85,504, $0.00");
    expect(view).toContain("91,500 total, in 1,200, out 300, cached 90,000, $0.12");
  });

  it("renders usage details in the single-session view", () => {
    const createdAt = "2026-04-30T10:24:42.731Z";
    const updatedAt = "2026-04-30T10:52:49.916Z";
    const view = buildSingleSessionView("/tmp/demo", {
      id: "ses_demo",
      status: "busy",
      createdAt,
      updatedAt,
      summary: "token probe",
      lastUsage: "InputTokens: 861, OutputTokens: 151, CachedTokens: 85504, CostUsd: $0.00",
      totalUsage: {
        totalTokens: 91500,
        inputTokens: 1200,
        outputTokens: 300,
        cachedTokens: 90000,
        costUsd: 0.12
      }
    });

    expect(view).toContain(`| created | ${formatReadableTimestamp(createdAt)} |`);
    expect(view).toContain(`| updated | ${formatReadableTimestamp(updatedAt)} |`);
    expect(view).toContain("| last usage | InputTokens: 861, OutputTokens: 151, CachedTokens: 85504, CostUsd: $0.00 |");
    expect(view).toContain("| total usage | 91,500 total, in 1,200, out 300, cached 90,000, $0.12 |");
    expect(view).toContain("| tree | id | parent | raw | observed | updated | last usage | total usage | summary |");
  });
});
