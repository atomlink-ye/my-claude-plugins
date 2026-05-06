# Orchestrator Subagent Tracking

Use this when an OpenCode session is acting as a manager/orchestrator and may spawn subagents, reviewers, or leaf sessions.

## Why quiescence can lie

The companion has to decide when a stream is "quiet enough" to return. For ordinary coding sessions, main-session silence is often a useful signal. For orchestrator prompts, the parent can go quiet while child sessions are still doing real work in the same directory or in related worktrees.

Symptoms:

- `job wait` or foreground `session new` returns quickly with a quiescence/delegated-settled style result.
- The summary says there were no file changes, but child sessions are still active.
- A later `git status -s` shows files written after the parent looked done.
- A retry creates duplicate work because the original children kept running.

## Default mitigation

For orchestrator-style tasks, set a longer quiescence window before launching:

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new --background --directory "$WORK_DIR" --agent orchestrator --prompt-file ./task.md
```

Use longer windows for known multi-agent dispatches. The goal is not to wait forever; it is to avoid treating a short parent silence as completion.

## Completion check

Before retrying or accepting completion:

```bash
node "$SCRIPT" session list --directory "$WORK_DIR"
node "$SCRIPT" session status "$SID" --directory "$WORK_DIR"
git -C "$WORKTREE_OR_REPO" status -s
```

Then check the task's actual artifacts:

- changed files in the assigned worktree,
- required reports or stdout contract,
- test output or artifact manifests,
- any child session IDs mentioned by the parent output.

If the parent is quiet but child sessions or worktree changes are still moving, wait or attach instead of relaunching.

## Follow-up pattern

If the session exists and needs more work:

```bash
node "$SCRIPT" session continue "$SID" --directory "$WORK_DIR" --prompt-file ./follow-up.md
```

If the stream dropped but the session may still be working:

```bash
node "$SCRIPT" session attach "$SID" --directory "$WORK_DIR" --timeout 5
```

If the companion result includes a job id, retrieve it, but treat the result as a report to verify, not proof:

```bash
node "$SCRIPT" job result "$JOB_ID" --directory "$WORK_DIR"
```

## What not to do

- Do not blindly retry a timed-out or quiet orchestrator task.
- Do not rely on parent-job verdict alone when the prompt told the session to delegate.
- Do not accept "no changes" until `git status -s` in the leaf worktree confirms it.
- Do not pull large artifact bundles just to peek at progress; inspect the targeted log or file when possible.
