# OpenCode Companion Troubleshooting

## Serve is not reachable

Check status first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve status --server-directory "$SERVER_DIR"
```

Start only when status shows no reachable managed serve:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" serve start --server-directory "$SERVER_DIR"
```

## Session timed out

If any session id exists, attach before retrying:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session attach "$SID" --directory "$WORK_DIR" --timeout 5
```

Do not restart serve or submit duplicate work just because a foreground stream dropped.

## Wrong directory

Sessions are tied to `--directory`. Reusing only a session id is unsafe; carry forward the original working directory.

## Shell failures

Quote paths and prompts. Put user prompt text after `--` so it cannot be parsed as a flag.

## Incomplete artifacts

Continue the same session with a narrow corrective prompt, then verify the artifact directly.
