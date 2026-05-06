# Background Jobs

There are two ways to avoid blocking the caller.

Preferred when the host agent supports background shell/tool execution: run a normal blocking `session new`, `session attach`, or `job wait` command in that host background mode. The command stays attached until OpenCode exits, and the host agent gets a completion notification.

Use companion-managed `--background` when you want the companion script itself to detach immediately and manage a job record.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  -- "<prompt>"
```

For manager/orchestrator prompts that may delegate to subagents, increase the quiescence timeout in either mode:

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  --agent orchestrator \
  --prompt-file ./task.md
```

The job id is the source of truth until the result is retrieved.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job status "$JOB_ID" --directory "$WORK_DIR"
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job wait "$JOB_ID" --directory "$WORK_DIR" --timeout 60
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job result "$JOB_ID" --directory "$WORK_DIR"
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job cancel "$JOB_ID" --directory "$WORK_DIR"
```

`job result` may contain partial logs for incomplete work. Retrieve and verify the session id and artifacts before entering a fix loop or reporting completion.

`--background` is the companion-managed job layer. It is not the same as shelling out with `&`.

If the goal is notification-driven waiting, run `job wait` itself in the host agent's background mode.

If `job wait` returns with a quiet/delegated result but the prompt launched subagents, check `session list`, child session statuses, and `git status -s` before accepting completion.
