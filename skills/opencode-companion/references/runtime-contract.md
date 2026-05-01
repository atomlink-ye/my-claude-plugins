# OpenCode Companion Runtime Contract

## Script path

Marketplace-level skills use the marketplace root as `${CLAUDE_PLUGIN_ROOT}`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" ...
```

Standalone OpenCode skill install path:

```bash
node "$HOME/.agents/skills/opencode-companion/scripts/opencode-companion.mjs" ...
```

Do not use the removed plugin path for new guidance; all OpenCode companion calls go through this skill-local script path.

## Supported verbs

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve status [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve start [--port N] [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve stop [--server-directory SERVER_DIR]

node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- "PROMPT"]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- "PROMPT"]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session attach <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session wait <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session list [--directory WORK_DIR] [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session status <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]

node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job list [--directory WORK_DIR] [--all]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job status <job-id> [--directory WORK_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job wait <job-id> [--directory WORK_DIR] [--timeout MINS]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job result <job-id> [--directory WORK_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" job cancel <job-id> [--directory WORK_DIR]

node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" review [--directory WORK_DIR] [--scope auto|working-tree|branch] [--base REF] [--wait|--background] [--adversarial] [FOCUS_TEXT]
```

## State boundaries

- `--directory WORK_DIR` is the project context for sessions/jobs.
- `--server-directory SERVER_DIR` is where managed serve state is stored.
- A reusable session requires both the same session id and the same working directory.
- Task timeout is not serve failure; do not restart serve just because a foreground stream dropped.

## Output contract

When a caller uses the companion as a thin forwarding layer:

- Forward stdout/stderr and returned metadata verbatim.
- Preserve `Session ID`, job id, paths, and failure details exactly.
- Do not upgrade ambiguous output into success.
- Verify files, diffs, tests, or job results before claiming completion.

## Shell safety

Quote all paths and user strings. Put prompts after `-- "PROMPT"` so prompt text is not parsed as flags.

## Long prompts

`session new` / `session continue` accept the prompt three ways:

1. Inline after `--`: `-- "PROMPT"` — fine for short prompts.
2. Stdin: pipe text in (foreground only). Background workers re-spawn so stdin is not preserved across the spawn.
3. `--prompt-file PATH`: companion reads the file. Use this for any prompt that risks crowding the shell ARG_MAX (~1 MB on macOS, ~128 KB per-arg on Linux). Mixing `--prompt-file` with `-- "PROMPT"` is rejected.

For `--background`, the companion auto-routes prompts above `OPENCODE_PROMPT_INLINE_MAX_BYTES` (default 65536 bytes) through a managed sidecar file: it writes `<work-dir>/.opencode-job-<jobid>.prompt`, passes `--prompt-file` to the worker, and the worker deletes the sidecar after reading. Smaller prompts still go through argv as before. To force file routing for all background prompts, set `OPENCODE_PROMPT_INLINE_MAX_BYTES=1`.
