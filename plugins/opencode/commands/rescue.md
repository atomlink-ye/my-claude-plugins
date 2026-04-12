---
description: Delegate investigation, fix request, or follow-up work to OpenCode
argument-hint: '[--background|--wait] [--model MODEL] [task description]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
skills:
  - opencode
---

Invoke the OpenCode companion **directly via Bash**.

Consult the `opencode` skill for invocation syntax, prompt composition, and result handling.

Execution:
1. Parse flags from `$ARGUMENTS`:
   - `--background` → use Bash `run_in_background: true`. Strip from prompt.
   - `--wait` → run Bash in foreground. Strip from prompt.
   - If neither flag is present, default to foreground.
   - `--model MODEL` → pass through to companion. Strip from prompt.
2. Compose the prompt using the `opencode` skill's prompt composition guidance.
3. Invoke the companion directly:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task \
     [--model MODEL] -- "PROMPT"
   ```
4. Apply the result handling rules from the `opencode` skill.

Presentation rules:
- Return the companion stdout verbatim.
- Do not paraphrase, summarize, rewrite, or add commentary around the output.

If the user did not supply a task, ask what OpenCode should investigate or fix.
