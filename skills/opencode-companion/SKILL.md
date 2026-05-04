---
name: opencode-companion
description: "OpenCode runtime companion. Load for OpenCode task/review/status/serve/rescue requests, session IDs, timeout recovery, attach/resume decisions, background jobs, and result forwarding."
user-invocable: true
---

# OpenCode Companion

OpenCode is a headless coding agent runtime. This skill lets you launch coding sessions, run code reviews, manage background jobs, and forward results — all through a single companion script.

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/skills/opencode-companion/scripts/opencode-companion.mjs"
else
  SCRIPT="$HOME/.agents/skills/opencode-companion/scripts/opencode-companion.mjs"
fi
```

## Typical workflows

### Delegate a coding task

```bash
node "$SCRIPT" session new --directory "$WORK_DIR" --timeout 60 -- "Add input validation to the /users endpoint. Run pnpm test before finishing."
```

The session blocks until done or timeout. On completion, verify the artifacts directly — don't trust progress output alone.

### Continue in the same session

When the result needs a fix or follow-up, reuse the session instead of starting fresh:

```bash
node "$SCRIPT" session continue "$SID" --directory "$WORK_DIR" --timeout 60 -- "The validation is missing email format check. Add it and re-run tests."
```

### Run a code review

```bash
# Review uncommitted changes
node "$SCRIPT" review --directory "$WORK_DIR" --scope working-tree --wait

# Adversarial review of a branch
node "$SCRIPT" review --directory "$WORK_DIR" --adversarial --scope branch --base main --wait
```

Critical/High findings are blockers unless the user explicitly accepts them.

### Run a task in the background

For long-running work that shouldn't block the foreground:

```bash
node "$SCRIPT" session new --background --directory "$WORK_DIR" -- "Refactor the payment module to use the new SDK."
# Returns a job ID immediately

node "$SCRIPT" job status "$JOB_ID"
node "$SCRIPT" job wait "$JOB_ID"
node "$SCRIPT" job result "$JOB_ID"
```

### Check or restart the serve

```bash
node "$SCRIPT" serve status
node "$SCRIPT" serve start    # if not running
node "$SCRIPT" serve stop
```

## When to read references

| You need to... | Read |
|---|---|
| Know every verb, flag, and path convention | `references/runtime-contract.md` |
| Decide reuse vs. fresh session; recover from timeout | `references/session-lifecycle.md` |
| Structure a good delegation prompt; handle ambiguous output | `references/thin-forwarding-workflow.md` |
| Manage background jobs (status, wait, cancel, partial results) | `references/background-jobs.md` |
| Run reviews or adversarial reviews | `references/review-workflows.md` |
| Debug "serve unreachable", stale sessions, shell quoting | `references/troubleshooting.md` |

## Non-negotiables

- **Reuse before relaunch.** If a session ID and working directory exist, continue or attach — don't start a new session.
- **Timeout is not failure.** Attach and verify before retrying: `session attach "$SID" --directory "$WORK_DIR" --timeout 5`.
- **Forward output verbatim.** Don't summarize or reinterpret companion stdout when the user asked for runtime output.
- **Quote everything.** Paths and prompts must be quoted; prompt text goes after `--`.
- **Verify artifacts directly.** Progress output and partial logs are not proof of completion.
