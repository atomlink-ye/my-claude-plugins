---
description: Pull Daytona sandbox artifacts into the local project
argument-hint: '[--directory DIR] [--output DIR] [--remote-path PATH]'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" pull
```

Append the user's arguments as normal shell-quoted argv entries. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
