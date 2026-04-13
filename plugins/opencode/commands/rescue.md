---
description: Delegate investigation, fix request, or follow-up work to OpenCode
argument-hint: '[--background|--wait] [--model MODEL] [task description]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
skills:
  - opencode
---

Route to the `opencode:opencode-agent` subagent.

Execution mode:
- `--background` means run the subagent in the background.
- `--wait` means run the subagent in the foreground.
- If neither flag is present, default to foreground.
- Strip `--background` and `--wait` from the forwarded prompt before sending it to the agent.
- Preserve `--model` when the user provides it, and pass it through to the agent.

If the user explicitly wants to bypass the agent and call the companion directly, consult the `opencode` skill. In that direct-call path, suggest Bash `run_in_background: true` only when non-blocking execution is desired.

Presentation rules:
- Return the companion stdout verbatim.
- Do not paraphrase, summarize, rewrite, or add commentary around the output.

If the user did not supply a task, ask what OpenCode should investigate or fix.
