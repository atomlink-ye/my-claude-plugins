---
description: Bundle and push a local file or directory into the Daytona sandbox
argument-hint: '[--directory DIR] [--task-id ID] --path PATH [--remote-path PATH] [--mode bundle]'
allowed-tools: Bash(node:*)
---

Run the Daytona manager with Bash using this base command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" push
```

Append the user's arguments as normal shell-quoted argv entries. Never append raw `$ARGUMENTS` to a shell string.

Present the manager output exactly as returned.
