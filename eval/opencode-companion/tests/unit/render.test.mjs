import { describe, expect, it } from "vitest";
import {
  buildTaskResult,
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

  it("includes a custom artifact root when provided", () => {
    expect(
      renderBackgroundTaskStart(
        "task-abc123-def456",
        "/abs/scripts/opencode-companion.mjs",
        "/tmp/my project",
        ".custom-artifacts"
      )
    ).toBe(
      "OpenCode task started in background as task-abc123-def456. Check status: node '/abs/scripts/opencode-companion.mjs' job status task-abc123-def456 --directory '/tmp/my project' --artifact-root '.custom-artifacts'\n"
    );
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
    expect(view).toContain("| tree | id | parent | raw | observed | updated |");
  });

  it("renders recent reasoning and tool traces in the single-session view when messages are available", () => {
    const createdAt = "2026-04-30T10:24:42.731Z";
    const updatedAt = "2026-04-30T10:52:49.916Z";
    const messagesBySessionId = new Map([
      [
        "ses_demo",
        [
          {
            info: { id: "msg_assistant", sessionID: "ses_demo", role: "assistant" },
            parts: [
              {
                id: "prt_reasoning",
                type: "reasoning",
                text: "Check recent logs\nCompare child activity"
              },
              {
                id: "prt_bash",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "git status --short\npnpm test eval/opencode-companion/tests/unit/render.test.mjs" },
                  output: {
                    exitCode: 0,
                    stdout: " M skills/opencode-companion/scripts/opencode-companion.mjs\n"
                  }
                }
              },
              {
                id: "prt_task",
                type: "tool",
                tool: "task",
                state: {
                  status: "completed",
                  input: { subagent_type: "explorer", description: "inspect repo structure" },
                  output: "task_id: ses_child_demo"
                }
              }
            ]
          }
        ]
      ]
    ]);

    const view = buildSingleSessionView(
      "/tmp/demo",
      {
        id: "ses_demo",
        status: "busy",
        createdAt,
        updatedAt,
        summary: "trace probe"
      },
      null,
      messagesBySessionId
    );

    expect(view).toContain("## Recent execution trace");
    expect(view).toContain("Check recent logs");
    expect(view).toContain("Compare child activity");
    expect(view).toContain("- bash [completed]: git status --short pnpm test eval/opencode-companion/tests/unit/render.test.mjs");
    expect(view).toContain("- task [completed]: explorer — inspect repo structure — sessions: ses_child_demo");
    expect(view).toContain("ses_child_demo");
  });

  it("hides tool output in session status traces while keeping commands readable", () => {
    const longOutput = `stdout:${"x".repeat(1400)}`;
    const messagesBySessionId = new Map([
      [
        "ses_demo",
        [
          {
            info: { id: "msg_assistant", sessionID: "ses_demo", role: "assistant" },
            parts: [
              {
                id: "prt_bash",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "pnpm test" },
                  output: { text: longOutput }
                }
              }
            ]
          }
        ]
      ]
    ]);

    const view = buildSingleSessionView(
      "/tmp/demo",
      {
        id: "ses_demo",
        status: "idle",
        createdAt: "2026-04-30T10:24:42.731Z",
        updatedAt: "2026-04-30T10:52:49.916Z",
        summary: "trace probe"
      },
      null,
      messagesBySessionId
    );

    expect(view).toContain("- bash [completed]: pnpm test");
    expect(view).not.toContain("output:");
    expect(view).not.toContain(longOutput);
  });

  it("keeps the main session trace primary and limits child activity in default session status", () => {
    const messagesBySessionId = new Map([
      [
        "ses_root",
        [
          {
            info: { id: "msg_root", sessionID: "ses_root", role: "assistant" },
            parts: [
              {
                id: "prt_root_reasoning",
                type: "reasoning",
                text: "Root planning stays primary"
              }
            ]
          }
        ]
      ],
      [
        "ses_child",
        [
          {
            info: { id: "msg_child", sessionID: "ses_child", role: "assistant" },
            parts: Array.from({ length: 7 }, (_, index) => ({
              id: `prt_child_${index + 1}`,
              type: "reasoning",
              text: `Child activity ${index + 1}`
            }))
          }
        ]
      ]
    ]);

    const hierarchyContext = {
      rootIds: ["ses_root"],
      summariesById: new Map([
        ["ses_root", { id: "ses_root", parentId: "", status: "busy", updatedAt: "2026-04-30T10:52:49.916Z", createdAt: "2026-04-30T10:24:42.731Z", lastUsage: null, totalUsage: null, summary: "root" }],
        ["ses_child", { id: "ses_child", parentId: "ses_root", status: "busy", updatedAt: "2026-04-30T10:52:59.916Z", createdAt: "2026-04-30T10:25:42.731Z", lastUsage: null, totalUsage: null, summary: "child" }]
      ]),
      childrenByParent: new Map([["ses_root", ["ses_child"]]]),
      summaries: []
    };

    const view = buildSingleSessionView(
      "/tmp/demo",
      {
        id: "ses_root",
        status: "busy",
        createdAt: "2026-04-30T10:24:42.731Z",
        updatedAt: "2026-04-30T10:52:49.916Z",
        summary: "trace probe"
      },
      hierarchyContext,
      messagesBySessionId
    );

    expect(view).toContain("Root planning stays primary");
    expect(view).toContain("Child activity 7");
    expect(view).toContain("Child activity 6");
    expect(view).toContain("Child activity 5");
    expect(view).toContain("Child activity 4");
    expect(view).toContain("Child activity 3");
    expect(view).toContain("- … 2 earlier trace entries omitted");
    expect(view.indexOf("- … 2 earlier trace entries omitted")).toBeLessThan(view.indexOf("Child activity 3"));
    expect(view).not.toContain("Child activity 2");
    expect(view).not.toContain("Child activity 1");
  });

  it("keeps reasoning and command truncation while hiding tool output details", () => {
    const longReasoning = `Thinking start\n${"r".repeat(1600)}`;
    const longCommand = `pnpm exec vitest run ${"x".repeat(900)}`;
    const longOutput = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const messagesBySessionId = new Map([
      [
        "ses_demo",
        [
          {
            info: { id: "msg_assistant", sessionID: "ses_demo", role: "assistant" },
            parts: [
              {
                id: "prt_reasoning",
                type: "reasoning",
                text: longReasoning
              },
              {
                id: "prt_bash",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: longCommand },
                  output: { stdout: longOutput }
                }
              }
            ]
          }
        ]
      ]
    ]);

    const view = buildSingleSessionView(
      "/tmp/demo",
      {
        id: "ses_demo",
        status: "idle",
        createdAt: "2026-04-30T10:24:42.731Z",
        updatedAt: "2026-04-30T10:52:49.916Z",
        summary: "trace probe"
      },
      null,
      messagesBySessionId
    );

    expect(view).toContain("[truncated, showing first");
    expect(view).toContain("- bash [completed]: pnpm exec vitest run");
    expect(view).not.toContain("output:");
    expect(view).not.toContain("line 80");
    expect(view).not.toContain("line 79");
    expect(view).not.toContain("line 4\n");
    expect(view).not.toContain(longReasoning);
    expect(view).not.toContain(longCommand);
  });
});

describe("buildTaskResult", () => {
  it("falls back to generic assistant text when no parts array is available", () => {
    const result = buildTaskResult({
      directory: "/tmp/demo",
      sessionId: "ses_demo",
      messages: [
        {
          info: { id: "msg_assistant", sessionID: "ses_demo", role: "assistant" },
          message: "fallback answer without parts"
        }
      ],
      streamedText: "",
      status: "completed"
    });

    expect(result.combined_text).toBe("fallback answer without parts");
  });
});
