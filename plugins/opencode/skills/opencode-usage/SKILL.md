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
  --session ses_XXXX --directory /abs/path/to/original/project -- "follow-up message"
```

**Sessions persist across serve restarts.** OpenCode stores all sessions,
messages, and parts in a global SQLite DB at `~/.local/share/opencode/opencode.db`
(plus content-addressable blobs under `~/.local/share/opencode/storage/`). The
DB is NOT scoped to the managed serve's pid — killing and re-spawning the
serve does not lose session history. To resume:

1. Pass the original session id via `--session`.
2. Pass the original project directory via `--directory` — this must match
   the directory the session was created under (the serve routes by
   `x-opencode-directory` header, and each session is bound to a
   `project_id` derived from that directory).
3. The current serve (whether original or a fresh one) queries the DB and
   replays the prior conversation as context.

If the companion reports "No managed OpenCode serve state found for <dir>",
that's the companion's own pid-file state, not the session storage. Run
`ensure-serve --directory <original-project-dir>` to spawn a fresh serve
keyed to the right project, then `task --session <id> --directory <dir>`
to resume.

**Caveat on a stuck session.** A session whose foreground stream dropped
while an @-delegation was in flight may remain "active" on the serve
indefinitely. Use `sessions --session <id>` to check liveness; if verdict
is `active` it's still working, if `idle` (no updates within the
`--since` threshold, default 5 minutes) it's safe to resume. Empty result
means the serve can't see it for the given directory — double-check the
`--directory` argument matches the session's project.

## List sessions

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" sessions \
  [--directory DIR] [--session SID] [--since MINUTES] [--limit N]
```

Verdict meaning:
- `active` — still working (updated within `--since`, default 5 min). **Do not retry.**
- `idle` — safe to retry or continue with `--session SID --directory DIR`.
- missing — not visible to the serve for the supplied `--directory`. Double-check
  the directory matches the session's original project before assuming the session
  is gone — sessions persist in the global DB at `~/.local/share/opencode/opencode.db`
  and can usually be resumed by pointing at the correct directory (see "Continue a
  session" above). If you genuinely need to drop it, fire fresh.

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
