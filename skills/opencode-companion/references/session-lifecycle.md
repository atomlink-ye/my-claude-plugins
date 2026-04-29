# OpenCode Session Lifecycle

## Default path

Use `session new` for a new work thread and `session continue` for follow-up work in the same thread.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<prompt>"
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session continue "$SID" \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<follow-up prompt>"
```

## Reuse before relaunch

Reuse the same session when the coding thread is continuous: fix rounds, follow-up implementation, narrowing a broad run, or continuing a review. This avoids duplicate work and keeps repo context warm.

Start fresh only when the old session is unrecoverable, the topic changed enough to contaminate context, or isolation is more valuable than continuity.

## Timeout is not failure

A dropped stream, timeout, or exit-1 can be a false negative. If a session id exists:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session attach "$SID" \
  --directory "$WORK_DIR" \
  --timeout 5
```

Keep attach windows bounded. If the session remains productive, continue attaching or waiting. Relaunch only after direct verification shows reuse is no longer reliable.

## Completion signals

`Session ID:`, a long stream, touched-files summaries, and non-empty logs are progress signals. Completion requires direct artifact verification.
