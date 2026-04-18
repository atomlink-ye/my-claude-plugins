---
description: Start, stop, or inspect the managed OpenCode serve process
argument-hint: 'start [--port N] [--server-directory DIR] | stop [--server-directory DIR] | status [--server-directory DIR]'
allowed-tools: Bash(node:*)
---

Route the request to the companion runtime:
- `start`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve start ...`
- `stop`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve stop ...`
- `status`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve status ...` to show serve health, version, and port

Rules:
- Prefer `--server-directory DIR` explicitly. If the user omits it, default to `--server-directory ~` so the managed serve is global and reusable.
- Preserve `--port N` only for `start`.
- If the user does not supply a valid subcommand, show the supported forms instead of guessing.
- Present the companion output exactly as returned.
