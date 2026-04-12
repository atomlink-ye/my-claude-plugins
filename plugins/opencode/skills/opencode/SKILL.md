---
name: opencode
description: Authoritative reference for OpenCode invocation, prompt composition, and result handling. Consult before ANY OpenCode usage — especially session operations (continue, resume, list), task delegation, and serve lifecycle. This is the single source of truth for companion CLI syntax, flags, and behavioral contracts.
user-invocable: false
---

# OpenCode Skill

Unified reference for delegating work to OpenCode. Covers invocation, prompt composition, result handling, and the runtime contract.

---

## 1. Invocation (Usage)

Direct-invocation reference for `opencode-companion.mjs`.

### Companion path

```
${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs
```

### Delegate a task

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task \
  [--directory DIR] [--model MODEL] [--session SID] -- "PROMPT"
```

**Preferred: call via Bash with `run_in_background: true`**, unless the user explicitly requests blocking behaviour. This keeps Claude Code free and delivers the full result via notification + output file when OpenCode finishes. Do **not** also pass the companion's own `--background` flag — that's a detached job-queue mode with different semantics.

### Continue a session

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

### List sessions

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" sessions \
  [--directory DIR] [--session SID] [--since MINUTES] [--limit N]
```

Verdict meaning:
- `active` — still working (updated within `--since`, default 5 min). **Do not retry.**
- `idle` — safe to retry or continue with `--session SID --directory DIR`.
- missing — not visible to the serve for the supplied `--directory`. Double-check
  the directory matches the session's original project before assuming the session
  is gone — sessions persist in the global DB and can usually be resumed by
  pointing at the correct directory.

### Serve lifecycle (prefer `/opencode:serve`)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" ensure-serve [--port N] [--directory DIR]   # start
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" check        [--directory DIR]              # status
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cleanup      [--directory DIR]              # stop
```

### Gotcha: false-negative "failed" notifications

Heavy planning or sub-agent delegation inside OpenCode (`@explorer`, `@librarian`, `@oracle`, …) can abort the foreground stream while the session keeps running on the serve. A `failed` / exit-1 notification does **not** mean the session is dead.

Before retrying, run `sessions` to check liveness. Blind retries double-fire and corrupt in-flight work.

Mitigations:
- Narrow scope; split multi-file work into additive steps chained via `--session`.
- OpenCode decides when to delegate to its own sub-agents. Do not instruct it to avoid them in prompts. On a false-negative abort, poll liveness with `sessions --session <id>` and resume with `--session <id>` when it goes idle.
- Keep prompts focused (50–150 lines of prompt is a good target).

---

## 2. Prompt Composition

### Core Rules

- Give one clear task per run.
- State the exact output contract up front.
- Ground the request in facts from the codebase, not assumptions.
- Include the relevant files, scope boundaries, and non-goals.
- Keep the prompt small enough that a single pass can finish it.
- If the task depends on repo state, say what must be checked before acting.

### Default Prompt Recipe

```xml
<task>
  One concrete coding task, phrased as an action with a clear finish line.
</task>

<output_contract>
  What the agent must return, the file scope, the required checks, and when to stop.
</output_contract>

<follow_through>
  What to do if blocked, what to verify before finalizing, and whether to keep iterating.
</follow_through>
```

### Selection Guidance

- Use `task` for implementation, refactors, fixes, or narrow code changes.
- Use `review` when you want a bug hunt, regression check, or evidence-backed critique without code changes.
- Use `adversarial-review` when you want the strongest attempt to break the plan, find edge cases, or challenge assumptions.
- If the request mixes implementation and review, split it into separate runs unless the review is only a verification step for the implementation.

### Common Antipatterns

- Bundling unrelated requests into one prompt.
- Saying "improve this" without defining what success looks like.
- Hiding important constraints inside long prose.
- Assuming files, modules, or architecture that have not been checked.
- Asking for implementation and final review in the same unconstrained pass.
- Telling OpenCode how to structure its internal work — describe the outcome you need, not the mechanism inside the session.
- Leaving verification implicit when the result will be reused or shipped.

### Verification Loop

- Check the result against the output contract before treating it as done.
- Verify that the work stayed within the requested scope.
- Verify that the result is grounded in the repository state or tool output.
- If the result is incomplete, rerun with a narrower scope and a tighter contract.
- If the result is uncertain, ask for the missing fact instead of guessing.

---

## 3. Result Handling

When the helper returns OpenCode output:
- Preserve the streamed text from the SSE response.
- Preserve the final session metadata block, including session ID, status, and directory.
- Preserve any reported file change summary exactly as the helper reports it.
- If the helper reports malformed output or a failed run, include the most actionable stderr lines and stop there.
- If the helper reports no file changes, keep that statement.
- If the helper reports file changes, call out the touched paths explicitly.

Presentation rules:
- Do not transform OpenCode output into a separate Claude-side implementation.
- Do not add repository analysis that OpenCode did not report.
- If the user asks what changed, answer from the helper output first.

CRITICAL:
- Stop after presenting the OpenCode results.
- Never auto-apply, refine, or extend OpenCode changes without explicit user permission.
- If the run failed or was incomplete, report that and stop instead of improvising a fallback implementation.

