---
name: opencode-result-handling
description: Internal guidance for presenting OpenCode helper output back to the user
user-invocable: false
---

# OpenCode Result Handling

When the helper returns OpenCode output:
- Preserve the streamed text from the SSE response.
- Preserve the final session metadata block, including session ID, status, and directory.
- Preserve any reported file change summary exactly as the helper reports it.
- If the helper reports malformed output or a failed run, include the most actionable stderr lines and stop there.
- If the helper reports no file changes, keep that statement.
- If the helper reports file changes, call out the touched paths explicitly.

Presentation rules:
- Do not transform OpenCode output into a separate Claude-side implementation.
- Do not add repository analysis that OpenCode did not report.
- If the user asks what changed, answer from the helper output first.

CRITICAL:
- Stop after presenting the OpenCode results.
- Never auto-apply, refine, or extend OpenCode changes without explicit user permission.
- If the run failed or was incomplete, report that and stop instead of improvising a fallback implementation.
