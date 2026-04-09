---
description: Delegate a coding task to OpenCode
argument-hint: '[--background|--wait] [--directory DIR] [--model MODEL] [task description]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route to the `opencode:opencode-agent` subagent.

Execution mode:
- `--background` means run the subagent in the background.
- `--wait` means run the subagent in the foreground.
- If neither flag is present, default to foreground.
- Strip `--background` and `--wait` from the forwarded agent prompt.
- Strip `--directory DIR` and `--model MODEL` from the agent prompt, then pass them through as companion args.

Presentation rules:
- Apply the `opencode-result-handling` skill to present the output.
- Return the companion stdout verbatim.
- Do not paraphrase, summarize, rewrite, or add commentary around the output.

If the user did not supply a task, ask what OpenCode should investigate or fix.
