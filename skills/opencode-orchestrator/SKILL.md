---
name: opencode-orchestrator
description: "Use when Hermes/Claude should act as the team lead for a multi-step local task: understand the goal, break it into bounded execution lanes, dispatch heavy implementation or review work to OpenCode Companion, reuse sessions intelligently, and accept or reject results. Trigger on team-lead or orchestrator requests, manager-vs-executor routing, direct Companion execution, session reuse, or multi-step work that should stay local by default."
user-invocable: false
---

# Team Lead Orchestration

Historical compatibility note: the skill name remains `opencode-orchestrator`, but on this machine this skill is the **team-lead handbook**.

Its **main path is local team-lead orchestration**:
- the team lead understands the task, sets the acceptance bar, and keeps final judgment
- OpenCode Companion handles bounded execution lanes
- **Daytona remote interaction is optional**, not the default. Read `references/daytona-remote-lane.md` only when the user explicitly wants a remote sandbox lane.

This skill owns **workflow, routing, and acceptance policy**, not every runtime flag.

## Overview

Default operating split:

```text
Team Lead (Hermes / Claude)
  -> understand scope and success bar
  -> decide what stays in the manager
  -> dispatch bounded execution lanes
  -> review artifacts, reroute fixes, and accept/reject

Local OpenCode Companion
  -> repo exploration
  -> implementation
  -> test and validation runs
  -> mechanical review work
```

Core rule: **keep the thinking, scoping, and acceptance in the team lead; push bounded execution to OpenCode.**

## Live local OpenCode snapshot

Set the snapshot helper path from this skill path when you need a quick local runtime check:

```bash
SNAPSHOT_SCRIPT="${SKILL_ROOT}/scripts/check-opencode-snapshot.sh"
bash "$SNAPSHOT_SCRIPT"
```

`${SKILL_ROOT}` is the path to this `opencode-orchestrator` skill directory. The helper uses OpenCode Companion to inspect the local runtime.

## When to use

Use this skill when:
- the user wants Hermes/Claude to stay in a **team lead / manager / orchestrator** role
- the task is multi-step and should stay **local by default**
- implementation, review, or repetitive repo investigation should be delegated
- session reuse matters
- the user wants **direct OpenCode Companion** instead of starting new `paseo run` work
- the main difficulty is routing, decomposition, fix-loop control, or acceptance discipline

## Main local-default rule

Unless the user explicitly asks for remote isolation, sandbox preview, or remote execution capacity, treat **local OpenCode Companion** as the default executor.

Daytona is an **opt-in expansion path**, not the main workflow.

## Ownership split

| Task shape | Owner |
|---|---|
| success criteria, non-goals, sequencing | Team Lead |
| planning, decomposition, integration judgment | Team Lead |
| final prose / governance / acceptance summary | Team Lead |
| concrete code edits | OpenCode |
| test writing / updating / reruns | OpenCode |
| repetitive repo scans or long tool loops | OpenCode |
| independent adversarial code review | separate OpenCode session |

## Local team-lead loop

1. **Set the bar in manager context.** Define success, non-goals, scope, and the checks that actually matter.
2. **Gather only task-relevant context.** Pick the exact docs, files, and paths the execution lane must read first.
3. **Choose the execution boundary.** If the work is not ultra-trivial, create one bounded OpenCode lane instead of doing a long in-chat tool grind.
4. **Launch the lane locally.** Prefer OpenCode Companion's direct session workflow when the user wants a TL-owned local workflow.
5. **Wait notification-first.** Do not babysit a foreground stream or poll in loops when the host can notify on completion.
6. **Inspect outputs directly.** Read the report, diff, and gate artifacts yourself.
7. **Route fix rounds back to the same session** when the topic is continuous.
8. **Use a separate session for review** when you want a genuinely independent second look.

## Local environment quickstart

Use the OpenCode Companion skill for local execution. Load that skill and use the `SCRIPT` value defined at its start, then run the session commands below.

Recommended launch pattern for substantial implementation work:

```bash
node "$SCRIPT" serve status

OPENCODE_QUIESCENCE_TIMEOUT_MS=120000 \
node "$SCRIPT" session new \
  --background \
  --directory "$WORK_DIR" \
  --agent orchestrator \
  --model openai/gpt-5.4 \
  --timeout 60 \
  --prompt-file ./task.md

node "$SCRIPT" job wait "$JOB_ID" --directory "$WORK_DIR" --timeout 60
```

Important notes:
- Let the **host** put long waits in the background when possible.
- `job wait`, `session attach`, and long `session new` runs should not block the team lead's whole conversation.
- Do not claim success from the stream alone; verify files, tests, and diffs.

## Worktree and directory discipline

- If the target repo is already dirty, create an isolated worktree first.
- When OpenCode needs broad read visibility, point `--directory` at the repo root but explicitly restrict write scope inside the prompt.
- If the task is a focused implementation lane, tell OpenCode exactly which worktree or subdirectory it may modify.
- Give the lane a small read-first list. Do not dump a generic "read the whole repo" instruction.

## Routing heuristics

Strong delegation signals:
- expected to exceed roughly **10 tool calls**
- likely to touch more than **5 files**
- repeated read/edit/test loops are expected
- the work benefits from warm repo context and session reuse
- the deliverable can be stated as a bounded execution lane with a clear stop condition

Structural misfits that should usually stay out of OpenCode even when the runtime is healthy:
- one tiny edit already in hand
- work that depends on a host-native tool OpenCode cannot express
- final authorship that should stay in the team lead's own voice

## Prompt contract for execution lanes

Every delegated lane should contain:

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

A good team-lead prompt also includes:
- exact read-first paths
- exact write scope
- exact acceptance checks
- whether this is an implementation lane, review lane, or evidence lane

## Session reuse and timeout discipline

- **Reuse before relaunch.** A live session is a warm teammate.
- **Timeout is not failure.** Preserve the session ID, inspect status, and attach or continue before starting fresh work.
- **Do not duplicate in-flight work.** A false timeout followed by a blind retry is worse than waiting.
- **Keep review independent.** Reuse the same generator session for fix rounds, but create a separate review session when you want a real second opinion.

## Acceptance checklist for the team lead

Before accepting a lane:
- read the produced report or relevant files directly
- inspect `git diff` / `git status` in the target scope
- verify the required checks actually ran
- distinguish `accepted`, `needs fix round`, and `blocked`
- do not confuse a clean summary with proof

## Optional remote expansion

If the user explicitly wants a remote sandbox lane, browser/service isolation, or remote preview capacity, read `references/daytona-remote-lane.md`.

That path is optional on purpose. The main skill remains **local team-lead orchestration first**.

## Read next

| Need | Read |
|---|---|
| companion verbs, background jobs, rescue, session lifecycle | `opencode-companion` |
| sandbox lifecycle and preview verbs | `daytona-companion` |
| optional remote team-lead lane via Daytona | `references/daytona-remote-lane.md` |

## Non-goals

This skill does **not** try to be:
- the full OpenCode Companion command reference
- the full Daytona lifecycle reference
- a mandate to make every task remote
- a replacement for acceptance judgment in the team lead
