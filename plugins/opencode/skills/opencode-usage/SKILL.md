---
name: opencode-usage
description: Invocation cheat-sheet for the OpenCode companion — how to delegate tasks, continue sessions, list sessions, and manage the serve process. Consult before invoking OpenCode from Bash directly.
user-invocable: false
---

# OpenCode Usage

Direct-invocation reference for `opencode-companion.mjs`. Pair with `opencode-prompting` (prompt composition) and `opencode-result-handling` (output presentation).

For the full authoritative spec, invoke `/opencode:task` or read `${CLAUDE_PLUGIN_ROOT}/commands/task.md`.

## Companion path

```
${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs
```

## Delegate a task

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task \
  [--directory DIR] [--model MODEL] [--session SID] -- "PROMPT"
```

**Preferred: call via Bash with `run_in_background: true`**, unless the user explicitly requests blocking behaviour. This keeps Claude Code free and delivers the full result via notification + output file when OpenCode finishes. Do **not** also pass the companion's own `--background` flag — that's a detached job-queue mode with different semantics.

## Continue a session

The previous task output ends with `Session ID: ses_...`. To reuse that session's memory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task \
  --session ses_XXXX -- "follow-up message"
```

Sessions are alive as long as the managed serve is alive. Restart = new session.

## List sessions

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" sessions \
  [--directory DIR] [--session SID] [--since MINUTES] [--limit N]
```

Verdict meaning:
- `active` — still working. **Do not retry.**
- `idle` — safe to retry or continue with `--session SID`.
- missing — serve restarted or aborted. Fire fresh.

## Serve lifecycle (prefer `/opencode:serve`)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" ensure-serve [--port N] [--directory DIR]   # start
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" check        [--directory DIR]              # status
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cleanup      [--directory DIR]              # stop
```

## Gotcha: false-negative "failed" notifications

Heavy planning or sub-agent delegation inside OpenCode (`@explorer`, `@librarian`, `@oracle`, …) can abort the foreground stream while the session keeps running on the serve. A `failed` / exit-1 notification does **not** mean the session is dead.

Before retrying, run `sessions` to check liveness. Blind retries double-fire and corrupt in-flight work.

Mitigations:
- Narrow scope; split multi-file work into additive steps chained via `--session`.
- OpenCode decides when to delegate to its own sub-agents (`@oracle`, `@explorer`, `@librarian`, `@designer`, …). Do not instruct it to avoid them in prompts — that's OpenCode's internal strategy, not yours to manage. On a false-negative abort, poll liveness with `sessions --session <id>` and resume with `--session <id>` when it goes idle.
- Keep prompts focused (50–150 lines of prompt is a good target).
