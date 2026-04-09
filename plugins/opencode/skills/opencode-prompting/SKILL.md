---
name: opencode-prompting
description: Guidance for composing effective OpenCode task prompts
user-invocable: false
---

# OpenCode Prompting

Use this skill when writing prompts for `opencode:opencode-agent` or the `commands/task.md` entrypoint.

## Core Rules

- Give one clear task per run.
- State the exact output contract up front.
- Ground the request in facts from the codebase, not assumptions.
- Include the relevant files, scope boundaries, and non-goals.
- Keep the prompt small enough that a single pass can finish it.
- If the task depends on repo state, say what must be checked before acting.

## Default Prompt Recipe

Prefer this structure for new prompts:

```xml
<task>
  One concrete coding task, phrased as an action with a clear finish line.
</task>

<output_contract>
  What the agent must return, the file scope, the required checks, and when to stop.
</output_contract>

<follow_through>
  What to do if blocked, what to verify before finalizing, and whether to keep iterating.
</follow_through>
```

Guidelines for each block:

- `task`: keep it singular, concrete, and repo-specific.
- `output_contract`: name the expected artifact, formatting, validation, or file changes.
- `follow_through`: say whether the agent should keep digging, verify, or stop on uncertainty.

## Selection Guidance

- Use `task` for implementation, refactors, fixes, or narrow code changes.
- Use `review` when you want a bug hunt, regression check, or evidence-backed critique without code changes.
- Use `adversarial-review` when you want the strongest attempt to break the plan, find edge cases, or challenge assumptions.
- If the request mixes implementation and review, split it into separate runs unless the review is only a verification step for the implementation.

## Common Antipatterns

- Bundling unrelated requests into one prompt.
- Saying "improve this" without defining what success looks like.
- Hiding important constraints inside long prose.
- Assuming files, modules, or architecture that have not been checked.
- Asking for implementation and final review in the same unconstrained pass.
- Leaving verification implicit when the result will be reused or shipped.

## Verification Loop

- Check the result against the output contract before treating it as done.
- Verify that the work stayed within the requested scope.
- Verify that the result is grounded in the repository state or tool output.
- If the result is incomplete, rerun with a narrower scope and a tighter contract.
- If the result is uncertain, ask for the missing fact instead of guessing.
