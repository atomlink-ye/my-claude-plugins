---
description: Show Daytona sandbox state for this project
argument-hint: '[--directory DIR] [--refresh] [--env-file FILE]'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" status
```

Append the user's arguments as normal shell-quoted argv entries. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
