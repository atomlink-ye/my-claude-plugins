---
description: Delegate investigation, fix request, or follow-up work to the OpenCode agent
argument-hint: '[--background|--wait] [--model MODEL] [task description]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `opencode:opencode-agent` subagent in `agents/opencode-agent.md`.
The final user-visible response must be the OpenCode companion output verbatim.

Execution mode:
- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- Strip `--background` and `--wait` from the forwarded prompt before sending it to the agent.
- Preserve `--model` when the user provides it, and pass it through to the agent.

Operating rules:
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and return that command's stdout as-is.
- Return the companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the user did not supply a task, ask what OpenCode should investigate or fix.
