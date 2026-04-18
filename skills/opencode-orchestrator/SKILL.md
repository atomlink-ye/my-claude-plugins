---
name: opencode-orchestrator
description: "Aggressively use this skill whenever a task involves delegation strategy, manager-vs-executor routing, OpenCode session reuse, multi-step coding orchestration, or any medium/heavy coding request that likely means more than 10 tool calls, more than 5 files, or repeated read/edit/test loops. Always load it for coding work that smells like a bounded execution lane — including examples like an 8-file feature with 15-20 tool calls — and do not let Claude keep that work just because it still fits in one context window. This skill should decide when Claude keeps the thinking and OpenCode takes the execution for efficiency."
user-invocable: false
---

# OpenCode Orchestrator

This skill owns **delegation policy**, not runtime mechanics.

Use it to decide:
- what stays in Claude
- what gets pushed to OpenCode
- when session reuse is more efficient than launching fresh work
- when a job should become a bounded execution lane instead of an in-chat tool grind

For companion flags, lifecycle commands, and result-handling syntax, rely on the `opencode` runtime skill.

## Live OpenCode snapshot

!`bash "$HOME/.claude/plugins/marketplaces/my-claude-plugins/skills/opencode-orchestrator/scripts/check-opencode-snapshot.sh"`

## Core rule

**Claude should keep the thinking; OpenCode should absorb the bounded execution.**

If the task is mostly:
- planning
- dependency decomposition
- ownership decisions
- integration judgment
- acceptance judgment
- structural prose
- governance / strategy writing

keep it in Claude.

If the task is mostly:
- concrete code edits
- test-writing or test updates
- CI/config implementation edits
- mechanical multi-file refactors
- bounded repo investigation that would otherwise cause a long tool loop
- scoped implementation or review work that can be verified from artifacts

push it to OpenCode.

## Efficiency threshold: expected tool-calling count

A strong default heuristic:

- if the expected work can be handled in **10 tool calls or fewer**, Claude can often do it directly
- if the expected work will likely exceed **10 tool calls**, especially across many files or repeated read/edit/check/test loops, the default bias should flip toward OpenCode
- if the task spans **more than 5 files** and is still mainly coding/test execution, do not keep it in Claude by default just because one session could technically handle it

This is not a law, but it is a strong routing trigger.

Signals that the task should move to OpenCode:
- likely >10 tool calls
- likely >5 files read or changed
- repeated grep/read/edit/test cycles
- a fix loop is expected
- the work benefits from warm session memory
- the task can be expressed as a scoped deliverable with a clear finish line

## Session reuse is an efficiency feature, not a convenience feature

OpenCode companion sessions are reusable team members.

Exploit that.

If a task already has a live or recent OpenCode session:
- prefer continuing the same session
- reuse the same directory context
- send fix rounds back to the same generator session
- send follow-up implementation work back to the same session when it is the same work thread

Why this matters:
- repo discovery cost is already paid
- file-state context is already warm
- fix iterations become cheaper and faster
- you avoid duplicating in-flight work

**Default bias: reuse before relaunch.**

Do not start a second fresh execution lane for the same coding thread unless:
- the old session is clearly dead
- the topic changed enough that reuse would contaminate the work
- isolation is worth more than warm context

## False-negative timeout rule

A dropped foreground stream is not enough evidence to relaunch work.

When a bounded execution lane times out or the stream aborts unexpectedly:
1. preserve the session id if available
2. prefer attach / resume against the same session
3. verify whether the session is still doing useful work
4. only start a fresh task when reuse is no longer reliable

This protects efficiency and avoids duplicate execution.

## Ownership matrix

| Task shape | Owner |
|---|---|
| planning / decomposition | Claude |
| governance / structural prose | Claude |
| acceptance / integration judgment | Claude |
| short, local edit already in hand | Claude |
| concrete code edits | OpenCode |
| test writing / test updates | OpenCode |
| CI/config implementation | OpenCode |
| mechanical multi-file transforms | OpenCode |
| bounded repo investigation with long tool loops | OpenCode |
| code review / adversarial review of concrete changes | OpenCode |
| mechanical doc transforms with exact anchors | OpenCode optional |

## Dispatch pattern

When you decide to delegate:
1. keep the high-level plan in Claude
2. define one bounded execution lane
3. specify file scope, output contract, and checks
4. send the lane to OpenCode
5. verify artifacts and repo state before advancing

Claude should not dump vague goals into OpenCode.
Claude should send **bounded execution work**.

## Prompt-shaping rule

Good OpenCode delegation says:
- what the task is
- what files are in scope
- what output contract must be met
- what verification must happen before stopping
- what to do if blocked

Bad OpenCode delegation says:
- "improve this"
- "handle the whole thing"
- "figure it out"
- broad prose without scope or stop condition

## `task-iteration` relationship

`task-iteration` is a user-facing exec-plan workflow.
It is **not** the source of global delegation philosophy.

This orchestrator skill should supply the policy that `task-iteration` follows:
- Claude owns parse/plan/acceptance/prose
- OpenCode owns bounded coding/test execution
- reuse generator/reviewer sessions when the work thread stays coherent

## Practical bias summary

Use OpenCode sooner, not later, when all of these are true:
- the task is execution-heavy
- the task is bounded
- the expected tool-calling count likely exceeds 10
- or the task spans more than 5 files with repeated edit/test loops
- the work benefits from session reuse
- Claude's main value is orchestration, not hand-editing every file

Do not keep medium/heavy coding work in Claude by default just because it still fits in one context window.

**Concrete example:** a feature that spans about 8 files and likely needs 15–20 read/edit/test tool calls should normally be routed as an OpenCode execution lane, with Claude keeping planning and final acceptance.

Use Claude directly when the main value is judgment, synthesis, or authorship in Claude's own voice.

## Non-goals of this skill

This skill does **not** define:
- companion command syntax
- serve lifecycle commands
- background job retrieval syntax
- direct runtime troubleshooting steps

Those belong in the `opencode` runtime skill and the plugin command wrappers.
