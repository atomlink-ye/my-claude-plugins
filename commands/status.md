---
description: Show the managed OpenCode serve status and recent sessions for this repository
argument-hint: '[--directory DIR]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status $ARGUMENTS`

Present the full command output to the user. Do not condense it.
