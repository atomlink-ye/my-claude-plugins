---
name: opencode
description: Authoritative reference for OpenCode companion invocation, session reuse, serve lifecycle, background jobs, and result handling. Always load this skill for any OpenCode runtime/lifecycle question — especially when the user mentions a session ID, timeout, attach/reattach, resume, rerun vs reuse, background job status, serve health, or companion-managed session reuse. If a timeout happened and a session ID exists, this skill should take over before Claude gives generic retry or restart advice.
user-invocable: false
---

# OpenCode Runtime Skill

This skill defines the **runtime contract** for OpenCode companion usage.

It does **not** define global delegation philosophy.
Use the orchestrator/global task policy to decide **whether** OpenCode should own a task.
Use this skill to decide **how** to run OpenCode safely and efficiently once that decision is made.

## Runtime scope

This skill owns:
- companion invocation
- serve lifecycle
- session reuse
- timeout / false-negative recovery
- background job handling
- review execution surfaces
- result handling
- artifact verification after companion runs

It should trigger aggressively for runtime questions such as:
- "the task timed out"
- "I have a session id"
- "should I attach or rerun?"
- "how do I resume this OpenCode job?"
- "check serve health / status / result / cancel"

## Preferred route: plugin commands and `opencode-agent`

Preferred order of use:
1. user-facing plugin commands such as `/opencode:task`, `/opencode:review`, `/opencode:status`
2. `opencode:opencode-agent` when Claude needs a thin task-forwarding wrapper
3. direct `opencode-companion.mjs` invocation only when low-level control is needed

The agent / command wrappers should forward companion output verbatim.
They should not invent repository analysis that the companion did not produce.

## Companion path

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs
```

Inside the OpenCode plugin, `${CLAUDE_PLUGIN_ROOT}` refers to the plugin root itself, so the companion lives directly under `scripts/`.

## Supported companion verbs

Primary namespaced surface:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve status [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve start [--port N] [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve stop [--server-directory SERVER_DIR]

node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] -- "PROMPT"
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] -- "PROMPT"
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session attach <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session wait <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session list [--directory WORK_DIR] [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session status <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]

node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job list [--directory WORK_DIR] [--all]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job status <job-id> [--directory WORK_DIR]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job wait <job-id> [--directory WORK_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job result <job-id> [--directory WORK_DIR]
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job cancel <job-id> [--directory WORK_DIR]

node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review [--directory WORK_DIR] [--scope auto|working-tree|branch] [--base REF] [--wait|--background] [--adversarial] [FOCUS_TEXT]
```

## Two kinds of state: do not mix them up

### 1. Serve state

Serve state answers:
- is the managed OpenCode runtime reachable?
- what port is it on?
- does the companion know about the managed serve process for this server directory?

Use:
- `serve status`
- `serve start`
- `serve stop`

For serve commands, prefer `--server-directory` explicitly. Legacy `--directory` still works as an alias for the server-state root.

### 2. Session / job state

Task state answers:
- what work was launched?
- is the same coding thread still reusable?
- do I have a background job id?
- do I have a session id to reattach to?

Use:
- `session new`
- `session continue`
- `session attach`
- `session wait`
- `session list`
- `session status`
- `job list`
- `job status`
- `job wait`
- `job result`
- `job cancel`

A task timeout is **not** the same thing as a serve failure.
Do not restart or relaunch just because one foreground stream dropped.

## Working directory vs server directory

These are different.

- `--directory WORK_DIR` = the repo / project context bound to the OpenCode session
- `--server-directory SERVER_DIR` = where companion-managed serve state is stored

The session is tied to the **working directory**.
If you want to reuse a session, reuse the same session id **and** the same working directory.

## Session reuse is the default efficiency path

OpenCode companion session reuse is a major efficiency feature.

Prefer reusing the same session when:
- fixing issues in the same work thread
- following up on a prior implementation
- continuing a code review thread
- narrowing a previous broad run into a final write / fix pass

Why:
- repo warmup has already happened
- file-state context is already loaded
- repeated implementation loops become cheaper
- you avoid duplicated work and duplicated token burn

### Reuse rule

If the coding thread is the same, bias toward:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session continue ses_XXXX \
  --directory /abs/path/to/original/project \
  -- "follow-up prompt"
```

Only start a fresh session when:
- the topic changed enough that warm context would be harmful
- the old session is clearly unrecoverable
- isolation is more valuable than continuity

## Foreground, background, and async

Default timeout for session work is now **60 minutes** unless explicitly overridden with `--timeout`.

Important runtime behavior update:
- the companion should **not** auto-force the `orchestrator` agent when no `--agent` is supplied
- if you want `orchestrator`, request it explicitly with `--agent orchestrator`
- otherwise let OpenCode/serve use its own default agent selection
- this avoids surprise nested delegation and the misleading force-quiescence endings that previously surfaced as `safety timeout`

### Foreground `session new` / `session continue`

Use when you want streamed output now and are willing to watch the run.

### `--background`

Use when you want a background **job id** and later retrieval via:
- `status`
- `result`
- `cancel`

This is the companion's managed background-job layer.
It is different from merely running a shell command in the background.

### `--async`

Use only when you intentionally want to queue a prompt asynchronously and handle the rest elsewhere.
This is not the normal default for task orchestration.

## Timeout / false-negative recovery

A dropped stream, timeout, or exit-1 does **not** automatically mean the OpenCode work failed.
Do not jump straight to generic retry, restart, or support-escalation advice if a reusable companion session is still available.

### Recovery procedure

1. capture any returned `Session ID: ses_...`
2. do **not** submit the same task again immediately
3. prefer attaching to the same session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" session attach ses_XXXX \
  --directory /abs/path/to/original/project \
  --timeout 5
```

4. keep attach windows bounded
5. if the session still appears productive, continue reattaching
6. only relaunch fresh work when reuse is no longer reliable

### Canonical timeout answer

If the user asks what to do after a timeout **and they already have a session id**, the default answer should be:
- attach to the same companion session
- keep the same working directory
- verify artifacts before considering a relaunch

Do **not** default to generic restart / support / configuration advice before covering attach-and-reuse.

### Strong rule

**Reuse before relaunch.**

This is both safer and cheaper.

## Background job monitoring

If you launched with `--background`, the source of truth is the job id.

Use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job status <job-id> --directory /abs/path/to/project
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job wait <job-id> --directory /abs/path/to/project --timeout 60
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job result <job-id> --directory /abs/path/to/project
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job cancel <job-id> --directory /abs/path/to/project
```

Important:
- `job list` shows the recent job table
- `job status` shows a single job snapshot
- `job wait` blocks until the job finishes or times out
- `job result` is for finished or partially finished background-job logs
- `job cancel` stops the active background job

## Progress is not completion

Never treat these as proof of success by themselves:
- `Session ID:` appearing early
- a long stream of reasoning / exploration output
- a touched-files summary
- a non-empty background log

Those are progress signals.
Not completion signals.

## Artifact verification is mandatory

A companion run is not done just because it produced output.

Always verify the requested artifact directly when an artifact matters.
Examples:
- read the target file
- inspect the diff
- inspect git status
- run the relevant test/build/lint/typecheck
- verify the file is substantial and not placeholder-level

### Strong rule

Do **not** trust a file-change summary as proof that the actual requested deliverable exists.

If the artifact is missing or incomplete:
- continue the same session
- narrow the prompt to writing the actual deliverable now
- verify again after the follow-up

## Review mode

The companion also exposes a higher-level `review` surface on top of repo git state.
Use `review` when you want a code review against repo state.
Use `review --adversarial` when you want a stronger challenge pass.

This is a runtime surface, but it is **not** part of the minimal serve/session/job lifecycle core.
When you want the user-facing wrapper, prefer plugin commands such as `/opencode:review` or `/opencode:adversarial-review`.
When you need low-level control, call the companion `review` command directly.

These are runtime surfaces, not strategy surfaces.
The orchestrator decides **when** to invoke them.
This skill defines **how** they run.

## Result-handling contract

When reporting OpenCode companion output:
- preserve the output as returned
- preserve session metadata and job ids
- preserve file paths and file-change summaries
- preserve failure details instead of paraphrasing them into confidence

If the run was incomplete or ambiguous, say so plainly.
Do not silently upgrade ambiguous output into success.

## Non-goals of this skill

This skill intentionally does **not** answer:
- whether a task should stay in Claude or move to OpenCode
- whether a planning/doc task should be delegated
- how the manager tree should be decomposed

Those belong in orchestration policy, not runtime mechanics.
