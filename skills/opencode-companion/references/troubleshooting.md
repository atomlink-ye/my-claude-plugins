# OpenCode Companion Troubleshooting

## Serve is not reachable

Check status first:

```bash
node "$SCRIPT" serve status --server-directory "$SERVER_DIR"
```

Start only when status shows no reachable managed serve:

```bash
node "$SCRIPT" serve start --server-directory "$SERVER_DIR"
```

## Session timed out

If any session id exists, attach before retrying:

```bash
node "$SCRIPT" session attach "$SID" --directory "$WORK_DIR" --timeout 5
```

Do not restart serve or submit duplicate work just because a foreground stream dropped.

## Orchestrator reported done too early

If a manager/orchestrator prompt returned after a short quiet period, inspect the session tree and the worktree before retrying:

```bash
node "$SCRIPT" session list --directory "$WORK_DIR"
node "$SCRIPT" session status "$SID" --directory "$WORK_DIR"
git -C "$WORKTREE_OR_REPO" status -s
```

Use `OPENCODE_QUIESCENCE_TIMEOUT_MS=120000` or a longer value for future orchestrator launches. See `orchestrator-subagent-tracking.md`.

## Keychain/auth unavailable in child commands

On macOS, a managed serve started before the user's keychain or provider auth is available can keep spawning child commands with the stale auth environment. If commands such as provider CLIs or workspace CLIs fail with keychain/auth errors even though they work in the current shell, restart the serve:

```bash
node "$SCRIPT" serve stop --server-directory "$SERVER_DIR"
node "$SCRIPT" serve start --server-directory "$SERVER_DIR"
```

## Wrong directory

Sessions are tied to `--directory`. Reusing only a session id is unsafe; carry forward the original working directory.

## Shell failures

Quote paths and prompts. Put user prompt text after `--` so it cannot be parsed as a flag.

## Incomplete artifacts

Continue the same session with a narrow corrective prompt, then verify the artifact directly.
