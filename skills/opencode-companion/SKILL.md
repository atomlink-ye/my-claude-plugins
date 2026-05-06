---
name: opencode-companion
description: "OpenCode runtime companion. Load for OpenCode task/status/serve/rescue requests, session IDs, timeout recovery, attach/resume decisions, background execution, context/usage checks, and result forwarding."
user-invocable: true
---

# OpenCode Companion

OpenCode is a headless coding agent runtime. This skill lets you launch coding sessions, continue existing sessions, attach/wait for results, manage the serve process, and forward outputs through a single companion script.

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/skills/opencode-companion/scripts/opencode-companion.mjs"
else
  SCRIPT="$HOME/.agents/skills/opencode-companion/scripts/opencode-companion.mjs"
fi
```

## Typical workflows

### Best practice: run the blocking session command in the background

Prefer a normal blocking `session new` command, but run that shell/tool invocation in the host agent's background mode. This keeps OpenCode's stream attached to the task, and the host agent receives a task-completion notification when the command exits.

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  --prompt-file ./task.md
```

Use this for substantial coding work. On completion, read the notification output, note the `Session ID`, then verify files/tests directly.

### First run or uncertain serve: use a companion background job

If this is the first OpenCode run in a workspace, or you are not sure the managed serve is healthy, start with the companion-managed background job path. It returns quickly with a job ID; then run `job wait` or `session attach` as a background shell/tool invocation so completion still arrives by notification rather than polling.

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --background \
  --directory "$WORK_DIR" \
  --timeout 60 \
  --prompt-file ./task.md

node "$SCRIPT" job status "$JOB_ID" --directory "$WORK_DIR"
node "$SCRIPT" job wait "$JOB_ID" --directory "$WORK_DIR" --timeout 60
node "$SCRIPT" job result "$JOB_ID" --directory "$WORK_DIR"
```

If the job output gives a `Session ID`, you can also attach to that session:

```bash
node "$SCRIPT" session attach "$SID" --directory "$WORK_DIR" --timeout 15
```

Run `job wait` or `session attach` in the host agent's background mode for long waits.

### Continue an existing session

The companion supports `session continue`. It is useful for fix rounds or follow-up work when preserving the same OpenCode conversation helps reuse repo context and avoid re-explaining the task. The caller decides whether the old context is still useful enough to continue.

```bash
node "$SCRIPT" session continue "$SID" \
  --directory "$WORK_DIR" \
  --timeout 60 \
  --prompt-file ./follow-up.md
```

Before continuing a very long-running session, check `session status "$SID"` and watch the usage/context lines. If the context appears near its limit or the topic has changed, start a fresh session instead.

### Check or restart the serve

```bash
node "$SCRIPT" serve status
node "$SCRIPT" serve start    # if not running
node "$SCRIPT" serve stop
```

On macOS, if child commands suddenly fail with keychain/auth errors after the serve was started early in the login session, restart the managed serve so provider CLIs inherit the current unlocked environment.

### Check session status and context

```bash
node "$SCRIPT" session status "$SID" --directory "$WORK_DIR"
node "$SCRIPT" session list --directory "$WORK_DIR"
```

When OpenCode exposes usage/context metadata, `session status` and task result summaries include it. Treat missing context data as "not reported by OpenCode", not as unlimited context.

## When to read references

| You need to... | Read |
|---|---|
| Know every verb, flag, and path convention | `references/runtime-contract.md` |
| Decide reuse vs. fresh session; recover from timeout | `references/session-lifecycle.md` |
| Structure a good delegation prompt; handle ambiguous output | `references/thin-forwarding-workflow.md` |
| Use companion-managed background jobs and wait/result flows | `references/background-jobs.md` |
| Track orchestrator sessions that spawn subagents or appear quiet too early | `references/orchestrator-subagent-tracking.md` |
| Debug "serve unreachable", stale sessions, shell quoting | `references/troubleshooting.md` |

## Non-negotiables

- **Reuse before relaunch.** If a session ID and working directory exist, continue or attach — don't start a new session.
- **But watch context.** Continue is efficient only while the existing context is still useful and not near its limit.
- **Timeout is not failure.** Attach and verify before retrying: `session attach "$SID" --directory "$WORK_DIR" --timeout 5`.
- **Quiet is not done for orchestrators.** If the prompt can spawn subagents, check `session list`, `session status`, and the worktree diff before accepting a quiescence result.
- **Prefer notification-driven waits.** Put blocking `session new`, `session attach`, or `job wait` invocations in the host agent's background mode instead of polling.
- **Forward output verbatim.** Don't summarize or reinterpret companion stdout when the user asked for runtime output.
- **Quote everything.** Paths and prompts must be quoted; prompt text goes after `--`.
- **Verify artifacts directly.** Progress output and partial logs are not proof of completion.
