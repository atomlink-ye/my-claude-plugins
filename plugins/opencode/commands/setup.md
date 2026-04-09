---
description: Check whether OpenCode is installed and the serve process is ready
argument-hint: '[--directory DIR]'
allowed-tools: Bash(node:*), Bash(brew:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" check "$ARGUMENTS"
```

If the check fails because OpenCode is not found and an install path is available:
- Use `AskUserQuestion` exactly once to ask whether the user wants to install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run one of:

```bash
npm install -g opencode
```

or:

```bash
brew install anomalyco/tap/opencode
```

- After installing, rerun the check command.

If OpenCode is already installed or the check passes:
- Present the final check output to the user.
- If the serve process is not ready, preserve the guidance from the companion output.
