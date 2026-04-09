---
description: Show OpenCode job status and recent sessions for this repository
argument-hint: '[job-id] [--all] [--directory DIR]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status "$ARGUMENTS"

If no job ID is provided, render the result as a compact Markdown table with columns for job ID, status, elapsed, model, prompt summary, and follow-up commands.

If a job ID is provided, present the full output verbatim without condensing, rewriting, or summarizing it.
