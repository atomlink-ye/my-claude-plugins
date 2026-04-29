# Background Jobs

Use `--background` when the run should continue without keeping the foreground stream open.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  -- "<prompt>"
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
