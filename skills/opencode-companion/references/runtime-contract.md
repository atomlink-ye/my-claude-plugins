# OpenCode Companion Runtime Contract

## Script path

Marketplace-level skills use the marketplace root as `${CLAUDE_PLUGIN_ROOT}`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" ...
```

Standalone OpenCode skill install path:

```bash
node "$HOME/.agents/skill/opencode-companion/scripts/opencode-companion.mjs" ...
```

Do not use the removed plugin path for new guidance; all OpenCode companion calls go through this skill-local script path.

## Supported verbs

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve status [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve start [--port N] [--server-directory SERVER_DIR]
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve stop [--server-directory SERVER_DIR]

node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] -- "PROMPT"
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] -- "PROMPT"
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
