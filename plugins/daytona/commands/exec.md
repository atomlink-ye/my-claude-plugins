---
description: Execute a command in the Daytona sandbox
argument-hint: '[--directory DIR] [--cwd PATH] -- COMMAND...'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" exec
```

Append the user's arguments as normal shell-quoted argv entries, preserving the `--` separator before the remote command. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
