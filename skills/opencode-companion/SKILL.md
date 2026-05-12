---
name: opencode-companion
description: "OpenCode runtime companion. Load for OpenCode task/status/serve/rescue requests, session IDs, timeout recovery, attach/resume decisions, background execution, context/usage checks, and result forwarding."
user-invocable: true
---

# OpenCode Companion

OpenCode is a headless coding agent runtime. This skill lets you launch coding sessions, continue existing sessions, attach/wait for results, manage the serve process, and forward outputs through a single companion script.

Set the companion script path from this skill path:

```bash
SCRIPT="${SKILL_ROOT}/scripts/opencode-companion.mjs"
```

`${SKILL_ROOT}` is the path to this `opencode-companion` skill directory. Set it from the loaded skill path; do not prepend another install root.

## Typical workflows

### Host-background note

Several patterns below say "run this in the host agent's background mode." That phrase has a concrete mapping per host:

- **Claude Code** — call the `Bash` tool with `run_in_background: true`. The shell stays alive until OpenCode exits; Claude Code emits a task-completion notification with an `output-file` path. Read that file to recover stdout (Session ID, status, etc.).
- **Other hosts** — use whatever lets a shell command run detached and notify on completion (e.g., a long-running task tool that returns on exit). The point is: keep OpenCode's stream attached, but free the orchestrator to do other work without polling.

Why this matters: OpenCode streams progress over an HTTP connection. If the orchestrator blocks on it, you lose parallelism; if you poll status, you waste tokens and risk treating partial logs as completion. Background-execution-with-notification gives both: continuous attachment + non-blocking caller.

### Team-lead orchestration bias on this machine

When Link explicitly wants Hermes/Claude to stay in a **team-lead** role — understanding the task, writing the brief, dispatching work, and only reviewing outputs — prefer the **direct OpenCode Companion script** over `paseo run` for new work.

Use this pattern:
1. `serve start` once if needed
2. launch bounded jobs with `session new --background ... --prompt-file ...`
3. monitor with `job status` / `job wait`
4. if the host supports it, put `job wait` itself in the host background with completion notification

Why this bias exists:
- `paseo` is fine for interactive agent driving, but here it added unnecessary indirection when the user wanted direct Companion execution.
- The direct companion path makes the split clearer: **Hermes = TL**, **OpenCode = executor**.
- It also pairs naturally with notification-driven `job wait`, so the TL can keep orchestrating instead of babysitting a foreground stream.

Practical rule:
- If the user says some version of **"后面不要用 paseo，直接用 OpenCode Companion"** or asks you to stay as TL while OpenCode executes, switch immediately to the direct companion script and do not start new work with `paseo run`.
- If a `paseo` run is already in flight, you can leave it alone and simply stop using `paseo` for subsequent tasks.

### Default path: blocking `session new`, run via host-background

Use a normal blocking `session new` and let the host put the shell call itself in the background.

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  --prompt-file ./task.md
```

Use this for substantial coding work. When the completion notification fires, read the notification's output file, capture the `Session ID`, then verify files/tests directly. Don't claim done from the stream alone.

### Fallback: companion-managed `--background` job

Reach for `--background` only when you specifically need the **companion script itself** to detach immediately and hand back a job record — for example, you want to inspect or cancel by job ID, or the host can't keep a long-lived shell open. The auto-managed serve already starts on demand, so first-run is *not* by itself a reason to use `--background`.

```bash
OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --background \
  --directory "$WORK_DIR" \
  --timeout 60 \
  --prompt-file ./task.md

# Then wait for completion via host-background:
node "$SCRIPT" job wait "$JOB_ID" --directory "$WORK_DIR" --timeout 60
node "$SCRIPT" job result "$JOB_ID" --directory "$WORK_DIR"
```

If the job result gives a `Session ID`, `session attach "$SID" --timeout 15` is also valid. Long waits (`job wait`, `session attach`) should themselves run in host-background.

**Machine-specific bias for substantial implementation work:** on this machine, when you want OpenCode to actually implement a non-trivial change rather than just discuss the approach, a reliable pattern is:

```bash
node "$SCRIPT" session new \
  --background \
  --directory "$WORK_DIR" \
  --agent orchestrator \
  --model openai/gpt-5.4 \
  --timeout 60 \
  --prompt-file ./task.md
```

Then wait with `job wait` and inspect with `job status` / `job result`.

Why this matters: a foreground run (or an open-ended prompt) can sometimes stop after returning a design/proposal instead of executing the code changes. If that happens, prefer reusing the same session with a hard follow-up such as:
- execute now
- do not stop for design confirmation
- add/update failing tests first, then implement, then run tests

In other words: **reuse the same session, tighten the prompt, then continue**. Do not assume you need a fresh relaunch just because the first response stayed at the design stage.

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

## Operating principles

These are the rules that keep the runtime honest. Each one exists because of a real failure mode:

- **Reuse before relaunch.** A session ID + working directory is a warm context. Starting a new session throws away repo state and forces re-explanation. Use `session continue` or `session attach`.
- **But watch context.** Reuse stops paying off once the context is near its limit or the topic has shifted — at that point the model gets distracted by stale history. Check `session status` for usage/context lines first, and start fresh when warranted.
- **Timeout is not failure.** A dropped stream or `--timeout` exit doesn't mean OpenCode died. Run `session attach "$SID" --timeout 5` to verify before retrying. Submitting duplicate work is the worst recovery.
- **Quiet is not done for orchestrators.** When the prompt can spawn subagents, the parent session can go quiet while children are still writing files. Check `session list`, child statuses, and `git status -s` in the worktree before accepting a quiescence result.
- **Current OpenCode completion wrinkle:** on current OpenCode versions observed on this machine (notably `1.14.46`), the SSE event stream can close **before** a session reaches a visible `idle`/terminal session-status update, even though the exported session already contains a completed assistant reply with `finish: "stop"` and a `step-finish` part. Treat stream-close-without-idle as ambiguous, not automatically failed.
- **Recovery rule for premature stream close:** after SSE closes without a terminal root status, keep polling a bit longer and also inspect persisted session messages. If the latest assistant message has final text plus completion markers like `info.time.completed`, `finish: "stop"`, or `step-finish`, treat the run as completed when there are no pending descendants or pending tool calls.
- **Grace window matters:** a short stream-close grace period can cause false failures. On this machine, extending the post-stream-close reconciliation window from ~4s to ~10s was enough for `OpenCode Companion` to recover successful `build` and `orchestrator` runs that previously ended with `OpenCode event stream ended before session completion.`
- **Prefer notification-driven waits.** Long-running `session new`, `session attach`, `job wait` should run via host-background (see top of Workflows). Polling in a loop wastes tokens and tempts premature completion calls.
- **Forward output verbatim.** When the user asked for runtime output, don't summarize companion stdout. Session IDs, job IDs, and error messages are load-bearing.
- **Quote everything.** Paths and prompts must be quoted; prompt text goes after `--` so it isn't parsed as flags.
- **Verify artifacts directly.** Progress logs and quiescence verdicts are *signals*, not proof. Read the file, run the test, check the diff.
