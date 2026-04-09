---
description: Run an OpenCode review that challenges design choices and implementation approach
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Execution contract:
- Inspect git status and diff size first so you can estimate whether the review is small or large:
  - `git status --short`
  - `git diff --stat`
  - `git diff --cached --stat`
- If `--scope branch`, also inspect:
  - `git log --oneline <base>..HEAD`
  - `git diff <base>...HEAD`
- If the user explicitly passed `--wait`, run the review in the foreground.
- If the user explicitly passed `--background`, run the review in the background.
- If neither flag is present, ask `AskUserQuestion` and recommend `--wait` for small diffs and `--background` for larger diffs.
- Run the companion with adversarial framing and preserve any optional focus text as trailing positional text:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review --adversarial $ARGUMENTS
```

- Return the command output verbatim.
