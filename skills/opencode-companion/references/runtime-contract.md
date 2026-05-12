# OpenCode Companion Runtime Contract

## Script path

Set the companion script path from this skill path:

```bash
SCRIPT="${SKILL_ROOT}/scripts/opencode-companion.mjs"
```

Use `node "$SCRIPT" ...` for all calls. `${SKILL_ROOT}` is the path to this `opencode-companion` skill directory.

## Supported verbs

```bash
node "$SCRIPT" serve status [--server-directory SERVER_DIR]
node "$SCRIPT" serve start [--port N] [--server-directory SERVER_DIR]
node "$SCRIPT" serve stop [--server-directory SERVER_DIR]

node "$SCRIPT" session new [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- "PROMPT"]
node "$SCRIPT" session continue <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--model MODEL] [--async] [--background] [--timeout MINS] [--prompt-file PATH | -- "PROMPT"]
node "$SCRIPT" session attach <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "$SCRIPT" session wait <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR] [--timeout MINS]
node "$SCRIPT" session list [--directory WORK_DIR] [--server-directory SERVER_DIR]
node "$SCRIPT" session status <session-id> [--directory WORK_DIR] [--server-directory SERVER_DIR]

node "$SCRIPT" job list [--directory WORK_DIR] [--all]
node "$SCRIPT" job status <job-id> [--directory WORK_DIR]
node "$SCRIPT" job wait <job-id> [--directory WORK_DIR] [--timeout MINS]
node "$SCRIPT" job result <job-id> [--directory WORK_DIR]
node "$SCRIPT" job cancel <job-id> [--directory WORK_DIR]

node "$SCRIPT" review [--directory WORK_DIR] [--scope auto|working-tree|branch] [--base REF] [--wait|--background] [--adversarial] [FOCUS_TEXT]
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
3. `--prompt-file PATH`: companion reads the file. Use this for any prompt that risks crowding the OS argv cap (~1 MB total on macOS, ~128 KB per-arg on Linux, 32,767 wide chars total on Windows). Mixing `--prompt-file` with `-- "PROMPT"` is rejected.

For `--background`, the companion auto-routes prompts above `OPENCODE_PROMPT_INLINE_MAX_BYTES` through a managed sidecar file: it writes `<work-dir>/.opencode-job-<jobid>.prompt`, passes `--prompt-file` to the worker, and the worker deletes the sidecar after reading. Smaller prompts still go through argv as before. To force file routing for all background prompts, set `OPENCODE_PROMPT_INLINE_MAX_BYTES=1`.

Default threshold is platform-aware:
- macOS / Linux: 65536 bytes (64 KB) — well below ARG_MAX and per-arg caps.
- Windows: 16384 bytes (16 KB) — leaves headroom under the 32,767-wide-char `CreateProcessW` total cap for the script path, flags, and quoting.
