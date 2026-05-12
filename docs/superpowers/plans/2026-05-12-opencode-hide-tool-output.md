# OpenCode Companion tool-output removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rendering `tool output` in OpenCode Companion's human-readable trace views while keeping raw logs and payloads intact.

**Architecture:** Keep the change localized to the shared trace-entry formatter so session/status views and live tool events stay consistent. Update the render tests first, then make the smallest implementation change that removes `output:` lines without touching raw payload handling.

**Tech Stack:** Node.js, ESM, Vitest

---

### Task 1: Lock in the new rendering contract with tests

**Files:**
- Modify: `eval/opencode/tests/unit/render.test.mjs`
- Test: `eval/opencode/tests/unit/render.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
it("does not render tool output in session status traces", () => {
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

  expect(view).not.toContain("output:");
  expect(view).toContain("command: pnpm test");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test eval/opencode/tests/unit/render.test.mjs`
Expected: FAIL because the current trace renderer still includes `output:` lines.

- [ ] **Step 3: Add a second assertion for the shared tool formatter behavior**

```javascript
it("keeps tool commands visible while hiding tool output details", () => {
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
  expect(view).toContain("command: [truncated, showing first");
  expect(view).not.toContain("output:");
  expect(view).not.toContain("line 80");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test eval/opencode/tests/unit/render.test.mjs`
Expected: FAIL because the renderer still exposes tool output.

### Task 2: Remove output rendering from the shared tool trace formatter

**Files:**
- Modify: `skills/opencode-companion/scripts/opencode-companion.mjs`
- Test: `eval/opencode/tests/unit/render.test.mjs`

- [ ] **Step 1: Write minimal implementation**

```javascript
function buildToolTraceEntry(part, sessionId = null, hierarchyContext = null, options = {}) {
  const name = getToolPartName(part) || String(readObjectField(part, ["name", "toolName", "tool_name"]) ?? "tool").trim().toLowerCase() || "tool";
  const state = getToolPartState(part);
  const detailLines = [];
  const command = extractToolCommand(part);
  if (command) {
    detailLines.push(`command: ${truncateTraceHead(command, MAX_RENDERED_TRACE_DETAIL_CHARS)}`);
  }
  const description = extractToolDescription(part);
  if (description && description !== command) {
    detailLines.push(`description: ${truncateTraceHead(description, MAX_RENDERED_TRACE_DETAIL_CHARS)}`);
  }
  const subagent = extractToolSubagent(part);
  if (subagent) {
    detailLines.push(`subagent: ${truncateTraceHead(subagent, MAX_RENDERED_TRACE_DETAIL_CHARS)}`);
  }
  const inputSummary = extractToolInputSummary(part);
  if (inputSummary && inputSummary !== command && inputSummary !== description) {
    detailLines.push(`input: ${truncateTraceHead(inputSummary, MAX_RENDERED_TRACE_DETAIL_CHARS)}`);
  }
  const exitCode = extractToolExitCode(part);
  if (exitCode) {
    detailLines.push(`exit: ${exitCode}`);
  }
  const sessions = describeToolSessionIds(part, hierarchyContext);
  if (sessions) {
    detailLines.push(`sessions: ${sessions}`);
  }
  return {
    sessionId,
    type: "tool",
    label: state ? `${name} [${state}]` : name,
    detailLines
  };
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test eval/opencode/tests/unit/render.test.mjs`
Expected: PASS

- [ ] **Step 3: Run a focused real-world verification**

Run: `node "skills/opencode-companion/scripts/opencode-companion.mjs" session new --directory "/tmp" --timeout 30 -- "List the current directory, then print a short summary of what you found."`
Expected: the live human-readable trace shows tool names and commands without any `output:` lines.

- [ ] **Step 4: Inspect logs for readability**

Run: `node "skills/opencode-companion/scripts/opencode-companion.mjs" session list --directory "/tmp"`
Expected: session metadata is still available and the run can be inspected without the trace summary dumping tool output.
