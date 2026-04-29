import { describe, expect, it } from "vitest";
import { renderBackgroundTaskStart, renderTaskSummary } from "../../../../skills/opencode-companion/scripts/opencode-companion.mjs";

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
