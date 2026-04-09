---
description: Run an OpenCode code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Execution contract:
- Inspect git status and diff size first so you can estimate whether the review is small or large:
  - `git status --short`
  - `git diff --stat`
  - `git diff --cached --stat`
- If `--scope branch`, also inspect the branch review context with:
  - `git log --oneline <base>..HEAD`
  - `git diff <base>...HEAD`
- If the user explicitly passed `--wait`, run the review in the foreground.
- If the user explicitly passed `--background`, run the review in the background.
- If neither flag is present, ask `AskUserQuestion` and recommend `--wait` for small diffs and `--background` for larger diffs.
- Then run the companion with the final flags:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review $ARGUMENTS
```

- Return the command output verbatim.
