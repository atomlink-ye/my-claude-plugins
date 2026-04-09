---
description: Delegate a coding task to OpenCode
argument-hint: '[--directory DIR] [--model MODEL] [--async] <prompt>'
allowed-tools: Bash(node:*)
---

Use the `opencode-result-handling` skill for the final presentation.

Execution contract:
- Extract `--directory DIR` if the user supplied it. If they did not, use the current Claude project directory.
- Start by ensuring the managed OpenCode serve process is running for that directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" ensure-serve --directory "<resolved-directory>"
```

- Then forward the original task request to the companion runtime exactly once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task $ARGUMENTS
```

Presentation rules:
- Stream the task command output to the user as it arrives.
- Preserve the companion output exactly; do not rewrite the OpenCode result into a Claude-authored implementation.
- After the command completes, present the result using the `opencode-result-handling` skill.
- Do not inspect the repository or make Claude-side edits before or after the OpenCode handoff.
