---
description: Show the stored output for a finished OpenCode background job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job result "$ARGUMENTS"`

Present the full command output to the user verbatim. Do not summarize, condense, or rewrite it.
