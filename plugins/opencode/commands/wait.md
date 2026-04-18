---
description: Wait for an OpenCode background job to finish and print the final result
argument-hint: '<job-id> [--directory DIR] [--timeout MINS]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" job wait $ARGUMENTS`
