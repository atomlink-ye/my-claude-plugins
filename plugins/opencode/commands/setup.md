---
description: Check whether OpenCode is installed and the managed serve runtime is ready
argument-hint: '[--server-directory DIR]'
allowed-tools: Bash(node:*), Bash(brew:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" serve status $ARGUMENTS
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

- After installing, rerun the serve-status command.

If OpenCode is already installed or the check passes, present the final output exactly as returned.
