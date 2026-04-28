---
description: Create or reconnect a Daytona sandbox for this project
argument-hint: '[--directory DIR] [--task-id ID] [--snapshot SNAPSHOT] [--name NAME] [--env-file FILE]'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" up
```

Append the user's arguments as normal shell-quoted argv entries. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
