---
description: Start, stop, or inspect the managed OpenCode serve process
argument-hint: 'start [--port N] [--directory DIR] | stop [--directory DIR] | status [--directory DIR]'
allowed-tools: Bash(node:*)
---

Route the request to the companion runtime:
- `start`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" ensure-serve ...`
- `stop`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cleanup ...`
- `status`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" check ...` to show serve health, version, and port

Rules:
- If the user supplies `--directory DIR`, preserve it. Otherwise default to `--directory ~` (the user's home directory) so serve runs as a global instance.
- Preserve `--port N` only for `start`.
- If the user does not supply a valid subcommand, show the supported forms instead of guessing.
- Present the companion output exactly as returned.
