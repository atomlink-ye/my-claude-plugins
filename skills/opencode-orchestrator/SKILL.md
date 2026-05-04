---
name: opencode-orchestrator
description: "Aggressively load this skill BEFORE any delegation decision — explore, plan, implement, review, adversarial second-opinion, bounded investigation, or any medium/heavy coding request. Also triggers for manager-vs-executor routing, OpenCode session reuse, multi-step coding orchestration, and work that likely exceeds 10 tool calls, 5 files, or repeated read/edit/test loops. When the live snapshot below shows OpenCode serve is reachable, this skill's routing takes precedence over the caller's generic delegation defaults across every delegated action, not only bounded coding execution. If serve is unreachable, fall back silently to the caller's defaults."
user-invocable: false
---

# OpenCode Orchestrator

This skill owns **delegation policy**, not runtime mechanics.

Use it to decide:
- what stays in Claude
- what gets pushed to OpenCode
- when session reuse is more efficient than launching fresh work
- when a job should become a bounded execution lane instead of an in-chat tool grind
- which delegation target to pick when multiple generic options exist (built-in sub-agents, other helpers, or OpenCode)

For companion flags, lifecycle commands, and result-handling syntax, rely on the `opencode-companion` runtime skill and its direct script path under `skills/opencode-companion/scripts/`.

## Live OpenCode snapshot

!`bash "${OPENCODE_ORCHESTRATOR_SNAPSHOT:-$HOME/.agents/skills/opencode-orchestrator/scripts/check-opencode-snapshot.sh}"`

If the standalone `~/.agents` copy is unavailable, run the marketplace copy directly: `bash "$HOME/.claude/plugins/marketplaces/my-claude-plugins/skills/opencode-orchestrator/scripts/check-opencode-snapshot.sh"`.

## Routing authority

This skill claims routing authority for delegation decisions while this session is active. The snapshot above is the self-check that gates that authority.

**Serve reachable (snapshot green) → OpenCode is the default delegation target.**

This covers every kind of delegation, not only coding execution:
- exploration / codebase scans
- implementation planning passes
- concrete implementation
- review and adversarial second opinion
- bounded investigation with long tool loops
- mechanical multi-file transforms

Rules while serve is reachable:
- Prefer OpenCode sessions over generic built-in sub-agents (Explore, Plan, general-purpose) for delegated work.
- Independent second opinion = a **separate OpenCode session**, isolated from the generator session. Do not switch providers to achieve independence.
- Reuse an existing OpenCode session when the work thread is continuous; start a fresh session when the topic has genuinely changed.
- The caller's generic routing defaults are overridden inside the delegation domain while serve is reachable.

**Serve not reachable / companion missing → fall back gracefully.**
- Surface the degradation briefly to the user.
- Let the caller's own routing defaults apply; do not block the task on OpenCode recovery unless the user asks.
- Do not keep pretending OpenCode is the default when the snapshot does not support it.

**Structural misfits (stay out of OpenCode even when reachable):**
- Ultra-trivial single-touch edit where delegation overhead exceeds the work itself.
- Task requires a Claude-native tool the companion cannot express.
- The task's real value is authorship or synthesis in Claude's own voice.

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

Those belong in the `opencode-companion` runtime skill and direct companion script, not this routing skill.
