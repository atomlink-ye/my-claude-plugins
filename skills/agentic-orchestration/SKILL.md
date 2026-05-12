---
name: agentic-orchestration
description: "Use when coordinating multi-step agentic work, choosing what stays with the lead agent versus delegated execution lanes, defining implementation/review/fix loops, or setting acceptance gates. Use for manager-vs-executor routing, independent reviews, bounded delegation, session/context reuse decisions, and orchestration policy independent of any specific runtime."
user-invocable: false
---

# Agentic Orchestration

Use this skill to decide **how to organize agentic work**. It defines the lead/execution split, lane boundaries, review independence, and acceptance discipline. It does not choose a specific runtime, model, vendor, host, or local configuration.

> **Migration note:** this skill takes over the role of providing **generic, runtime-neutral orchestration guidance**. The previous `opencode-orchestrator` skill bundled generic principles with OpenCode-specific defaults; generic principles now live here, OpenCode-specific operational details belong in `opencode-companion`, and any machine-specific routing belongs in a local routing profile — not in a public marketplace skill.

## Core Split

The lead agent owns judgment:
- understand the user's goal
- define success criteria, non-goals, scope, and sequencing
- decide what work can be delegated
- integrate results across lanes
- accept, reject, or reroute outputs
- produce final user-facing summaries

Execution lanes own bounded work:
- implement a scoped change
- explore a codebase surface
- write or run tests
- perform a focused review
- gather evidence
- apply a specific fix round

Core rule: **keep intent, scope, and acceptance in the lead; send bounded execution to lanes only when the lane has a clear finish line.**

## When To Delegate

Prefer an execution lane when:
- the work is likely to exceed roughly 10 tool calls
- the task spans several files or repeated read/edit/test loops
- the work benefits from isolated context
- the output can be judged by explicit acceptance criteria
- a separate review perspective would reduce self-confirmation
- the lead can keep moving while the lane runs

Keep work in the lead agent when:
- the edit is tiny and already understood
- the work is mostly product judgment, prioritization, or final wording
- the task depends on a host-native tool unavailable to lanes
- the user is asking for analysis or a plan rather than execution
- delegation overhead would be larger than the work

## Lane Types

Use lane names as role contracts, not as runtime names.

| Lane | Purpose | Edit permission |
|---|---|---|
| Exploration | Map files, risks, interfaces, or unknowns | Usually read-only |
| Implementation | Make scoped code/docs/test changes | Yes, within declared scope |
| Fix | Address specific findings after review | Yes, minimal changes only |
| Review | Check implementation against spec and tests | No |
| Advisory | Adversarial final gate over the whole diff | No |
| Evidence | Run commands and collect proof | Usually no |

## Independence Rules

- Implementation and review should be separate lanes when quality matters.
- A fix lane may reuse the implementation lane's context when the topic is continuous.
- A review lane should stay independent from the implementation lane.
- Advisory review should be fresh when it is the final gate.
- Do not ask the same lane to both produce and certify the same work unless the task is trivial or the user explicitly accepts that tradeoff.

## Execution Boundary

Every delegated lane needs a tight boundary:

```xml
<task>
One concrete task with a clear finish line.
</task>
<output_contract>
Files or artifacts to produce, checks to run, stop condition, and what to report back.
</output_contract>
<follow_through>
What to do if blocked, what not to touch, and how to verify before stopping.
</follow_through>
```

Also include:
- read-first paths
- allowed write scope
- relevant spec, plan, or acceptance criteria
- required commands or checks
- whether the lane is allowed to edit files
- what counts as blocked

## Context Reuse

Reuse a lane when continuity helps:
- fix rounds after an implementation
- follow-up validation on the same topic
- narrowing a previous attempt
- preserving repo context lowers repeated setup cost

Start fresh when:
- review independence matters
- the task topic changed
- old context may bias the result
- the prior lane became confused or overloaded
- isolation is more valuable than continuity

## Acceptance

The lead agent accepts work only after direct verification:
- read produced artifacts or relevant files
- inspect the diff in the target scope
- confirm required checks actually ran
- classify the result as `accepted`, `needs fix`, or `blocked`
- route fixes with concrete findings, not vague dissatisfaction

Do not accept a lane because its summary sounds confident. Summaries are signals; artifacts and checks are evidence.

## Runtime Selection

This skill does not select the executor. Choose the runtime from the user's explicit instruction, available host capabilities, or applicable local/project configuration. If a local runtime profile skill exists and applies, load it before launching lanes.

The selected runtime must still honor this skill's boundaries: scoped task, explicit output contract, independent review when needed, and lead-owned acceptance.

## Non-Goals

This skill is not:
- a command reference for any runtime
- a model selection guide
- a local machine policy
- a remote sandbox policy
- a replacement for final acceptance judgment
