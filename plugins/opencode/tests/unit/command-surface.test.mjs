import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSingleSessionView,
  buildSessionListView,
  deriveSessionLifecycleVerdict,
  recommendSessionAction,
} from "../../scripts/opencode-companion.mjs";
import { DEFAULT_SESSION_TIMEOUT_MINS } from "../../scripts/opencode-companion/constants.mjs";

const companionPath = path.resolve(
  process.cwd(),
  "plugins/opencode/scripts/opencode-companion.mjs",
);

describe("opencode companion command surface", () => {
  it("documents the namespaced session and job commands with a 60-minute default", () => {
    const source = fs.readFileSync(companionPath, "utf8");

    expect(source).toContain("session new");
    expect(source).toContain("session continue");
    expect(source).toContain("session attach");
    expect(source).toContain("session wait");
    expect(source).toContain("session list");
    expect(source).toContain("session status");
    expect(source).toContain("job list");
    expect(source).toContain("job status");
    expect(source).toContain("job wait");
    expect(DEFAULT_SESSION_TIMEOUT_MINS).toBe(60);
    expect(source).not.toContain("Convenience aliases");
  });

  it("renders session list and detail views", () => {
    const sessions = [
      {
        id: "ses_demo123",
        status: "running",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:10:00Z",
        title: "Demo session",
      },
    ];

    const listView = buildSessionListView("/tmp/demo", sessions);
    const detailView = buildSingleSessionView("/tmp/demo", sessions[0]);

    expect(listView).toContain("# OpenCode Sessions");
    expect(listView).toContain("ses_demo123");
    expect(detailView).toContain("# OpenCode Session Status");
    expect(detailView).toContain("Demo session");
    expect(detailView).toContain("lifecycle verdict");
    expect(detailView).toContain("recommended next action");
    expect(deriveSessionLifecycleVerdict("running")).toBe("active");
    expect(recommendSessionAction("ses_demo123", "running")).toContain("session attach ses_demo123");
  });
});
