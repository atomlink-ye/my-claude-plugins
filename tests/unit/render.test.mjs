import { describe, expect, it } from "vitest";
import { renderBackgroundTaskStart } from "../../scripts/opencode-companion.mjs";

describe("renderBackgroundTaskStart", () => {
  it("renders the basic case", () => {
    expect(renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs")).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode-companion.mjs' status task-abc123-def456\n"
    );
  });

  it("wraps a path with spaces in single quotes", () => {
    expect(
      renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode companion.mjs", "/tmp/my project")
    ).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode companion.mjs' status task-abc123-def456 --directory '/tmp/my project'\n"
    );
  });

  it("escapes single quotes in paths", () => {
    expect(
      renderBackgroundTaskStart("task-abc123-def456", "/abs/scripts/opencode-companion.mjs", "/tmp/dir's project")
    ).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode-companion.mjs' status task-abc123-def456 --directory '/tmp/dir'\\''s project'\n"
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
