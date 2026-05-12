# Background Jobs

This page is about the **companion-managed** `--background` flow — the case where the companion script detaches immediately and returns a job ID. For the more common case (blocking `session new` run via the host's own background mode, e.g. Claude Code's `Bash` `run_in_background: true`), see SKILL.md → "Host-background note" / "Default path".

## When to use `--background`

Use this flow when you specifically need any of:

- a job ID you can inspect, cancel, or hand off independently of the calling shell,
- the companion process itself to return immediately (e.g., the host has no long-lived background mode),
- decoupling the lifetime of the work from the lifetime of the orchestrator's session.

If you only want notification-driven waiting, prefer the host-background path — it's simpler and OpenCode stays attached the whole time.

## Launching

```bash
node "$SCRIPT" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  -- "<prompt>"
```

For manager/orchestrator prompts that may delegate to subagents, raise the quiescence window so a brief parent silence isn't mistaken for completion:

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  --agent orchestrator \
  --prompt-file ./task.md
```

## Job lifecycle

Until you retrieve and verify a result, the job ID is the source of truth — not stream snippets, not the launching command's exit code.

```bash
node "$SCRIPT" job status "$JOB_ID" --directory "$WORK_DIR"
node "$SCRIPT" job wait   "$JOB_ID" --directory "$WORK_DIR" --timeout 60
node "$SCRIPT" job result "$JOB_ID" --directory "$WORK_DIR"
node "$SCRIPT" job cancel "$JOB_ID" --directory "$WORK_DIR"
```

`job wait` itself is a long blocking call — run it via the host's background mode so completion arrives by notification rather than polling.

## Treat results as reports, not proof

`job result` may return partial logs for incomplete work. Pull the session ID and inspect artifacts before entering a fix loop or claiming success.

If the prompt could have spawned subagents, a "quiet" job result is especially suspect: check `session list`, child session statuses, and `git status -s` in the assigned worktree before accepting completion. See `orchestrator-subagent-tracking.md`.

## What `--background` is not

`--background` is the companion's own job layer. It is **not** the same as appending `&` to the shell command — that just detaches the OS process and loses the stream entirely.
