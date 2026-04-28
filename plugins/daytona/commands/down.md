---
description: Delete the Daytona sandbox for this project
argument-hint: '[--directory DIR] [--keep-state] [--env-file FILE]'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" down
```

Append the user's arguments as normal shell-quoted argv entries. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
