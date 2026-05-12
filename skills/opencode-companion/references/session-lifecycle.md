# OpenCode Session Lifecycle

## Default path

Use `session new` for a new work thread and `session continue` for follow-up work in the same thread.

```bash
node "$SCRIPT" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<prompt>"
```

```bash
node "$SCRIPT" session continue "$SID" \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<follow-up prompt>"
```

## Reuse before relaunch

Reuse the same session when the coding thread is continuous: fix rounds, follow-up implementation, narrowing a broad run, or follow-up validation. This avoids duplicate work and keeps repo context warm.

This is a capability, not a hard rule. The caller decides when continuity is worth it. Start fresh when the old session is unrecoverable, the topic changed enough to contaminate context, the context is near its limit, or isolation is more valuable than continuity.

Check the session before a long follow-up:

```bash
node "$SCRIPT" session status "$SID" \
  --directory "$WORK_DIR"
```

If OpenCode reports usage/context metadata, the status output includes it.

## Timeout is not failure

A dropped stream, timeout, or exit-1 can be a false negative. If a session id exists:

```bash
node "$SCRIPT" session attach "$SID" \
  --directory "$WORK_DIR" \
  --timeout 5
```

Keep attach windows bounded. If the session remains productive, continue attaching or waiting. Relaunch only after direct verification shows reuse is no longer reliable.

For orchestrator sessions that spawn subagents, also read `orchestrator-subagent-tracking.md`. A quiet parent session can return before child sessions finish.

## Completion signals

`Session ID:`, a long stream, touched-files summaries, and non-empty logs are progress signals. Completion requires direct artifact verification.

For code work, verify the assigned checkout:

```bash
git -C "$WORKTREE_OR_REPO" status -s
```
