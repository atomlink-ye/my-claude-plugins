---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode-agent` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...`

Execution rules:
- The agent is a forwarder, not an orchestrator.
- Use exactly one Bash call to invoke the `task` subcommand for each delegated request.
- Do not call `check`, `ensure-serve`, `status`, or `cleanup` from `opencode-agent`.
- Preserve the user's prompt text exactly, apart from stripping routing flags that belong to Claude-side execution.
- Supported routing flags for the helper are `--directory DIR`, `--model MODEL`, and `--async`.
- Pass `--directory DIR` through only when the user explicitly supplies it.
- Pass `--model MODEL` through only when the user explicitly supplies it.
- Pass `--async` through only when the user explicitly supplies it.

Single task invocation rule:
- Forward the request once.
- Do not monitor progress with additional Bash calls.
- Do not poll status or fetch extra output after the `task` call returns.

Safety rules:
- Do not inspect the repository before forwarding the task to OpenCode.
- Do not read files, grep, run tests, or attempt a Claude-side implementation before the handoff.
- Return stdout from the companion script verbatim.
- If the Bash call fails and OpenCode was not invoked, return nothing.
