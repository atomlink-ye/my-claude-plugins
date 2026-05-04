---
name: task-iteration
description: "Orchestrate end-to-end feature implementation from an exec-plan document. Use this whenever the user wants a structured Plan → Generate → Evaluate loop for a feature. It keeps planning and acceptance in Claude, pushes bounded coding/test execution to OpenCode companion sessions, reuses warm sessions across fix rounds, and gates completion on independent evaluation plus an advisory review."
user-invocable: true
---

# Task Iteration

Orchestrate exec-plan-driven feature delivery using a structured **Plan → Generate → Evaluate** loop.

**Invocation:** `/task-iteration <exec-plan-path> [feature-identifier] [--max-fix-rounds N]`

## What this skill owns

This is a **user-facing workflow skill**.
It owns:
- exec-plan parsing
- phase sequencing
- generator/reviewer bookkeeping
- checklist completion logic
- final advisory gate
- concrete companion command patterns for GENERATE / EVALUATE / FIX LOOP

It does **not** define the global delegation philosophy or low-level OpenCode runtime syntax by itself.

Use these layers together:
- **Global task policy / hidden orchestrator skill** → decides what stays in Claude vs what becomes an OpenCode execution lane
- **OpenCode runtime skill** → defines companion invocation, session reuse, timeout recovery, and result handling
- **This skill** → sequences the feature-delivery loop on top of those two layers

## Overview

Seven phases run in sequence.

- Claude owns parse / plan / acceptance / judgment-heavy prose
- OpenCode companion owns bounded coding / test execution lanes
- generator and reviewer sessions are reused when that is more efficient than relaunching

```
PARSE → PLAN → GENERATE → EVALUATE → FIX LOOP → ADVISORY → DONE
                       ↓           ↑
                       └── up to N ┘
```

## Key principles

- **Generator = Fixer.** One OpenCode companion session (`GENERATOR_SID`) handles initial implementation and all subsequent fix iterations.
- **Reviewer stays independent.** A separate session (`REVIEWER_SID`) evaluates the Generator's output.
- **Whole picture, scoped work.** Generator and Reviewer get the full feature context, but each run stays constrained to its role and file scope.
- **Structural prose stays with Claude.** Planning docs, governance docs, exec-plan updates, and completion summaries default to Claude unless a doc change is explicitly a mechanical transformation.
- **Session reuse is an efficiency feature.** Reusing the same generator/reviewer sessions avoids repeating repo warmup and keeps fix rounds cheaper.
- **Reuse before relaunch.** If a companion run times out or the stream drops after yielding a session id, attach to the same session before launching fresh work.
- **Bounded fix loop.** Max 3 rounds by default, with early exit on clean pass.

## Efficiency heuristic

If the expected execution lane would likely require **more than 10 tool calls** in Claude — especially across many files or repeated read/edit/test loops — prefer pushing that lane to OpenCode companion rather than grinding it out directly in chat.

This applies strongly to:
- implementation passes
- test-writing passes
- fix rounds
- bounded code review passes

## Session tracking

| Session / handle | Created | Reused for |
|---|---|---|
| `GENERATOR_SID` | Phase 3 | All fix iterations |
| `REVIEWER_SID` | Phase 4 | All re-evaluations |
| `GENERATOR_JOB_ID` / `REVIEWER_JOB_ID` | optional if using companion background jobs | monitoring and result retrieval |
| Advisory session | Phase 6 | fresh each time |

Always track:
- session id
- working directory
- base ref
- whether the run used foreground attach/recovery or companion background jobs

A session id without the original working directory is not enough for safe reuse.

---

## Phase 1: PARSE

Read the exec-plan and extract the target feature.

1. Read the exec-plan file at `<exec-plan-path>`.
2. Load `references/exec-plan-parsing.md`.
3. Extract:
   - User story
   - Specification
   - Deliverable standard
   - Test scenarios
   - Checklist items
   - Authority references
4. If no `[feature-identifier]` is given, list available features and ask the user to choose.
5. Record current git ref as `BASE_REF`:

   ```bash
   git rev-parse HEAD
   ```

6. Present the extracted summary for confirmation.

**Exit criteria:** User confirms the target feature.

## Phase 2: PLAN

Map the implementation surface and draft a plan.

1. Explore the relevant codebase surface:
   - files to modify or create
   - existing patterns to follow
   - interfaces that change
   - test locations
2. Draft a concise implementation plan covering:
   - what changes
   - where it changes
   - execution order
   - risks / edge cases
   - prerequisite dependencies from the exec-plan
3. Present the plan for approval.

**Exit criteria:** User approves the plan.

## Phase 3: GENERATE

Delegate the initial implementation to OpenCode companion.

1. Load `references/prompt-templates.md` and use the **Initial Implementation** template.
2. Compose the Generator prompt with:
   - `{{FEATURE_SPEC}}`
   - `{{USER_STORY}}`
   - `{{DELIVERABLE_STANDARD}}`
   - `{{PLAN}}`
   - `{{FILE_SCOPE}}`
   - `{{AUTHORITY_REFERENCES}}`
3. Include the whole picture, but restrict output to the declared file scope.
4. Dispatch to OpenCode companion.

### Preferred companion pattern

Use the companion-managed task flow, not raw `opencode run`.
When the user asks for the concrete GENERATE or FIX LOOP command pattern, answer with these `opencode-companion.mjs` command forms directly rather than inventing extra phase-specific entrypoints.
In this marketplace-level skill, `${CLAUDE_PLUGIN_ROOT}` refers to the marketplace root, so the companion lives under `skills/opencode-companion/scripts/`.

### Canonical answer shape for command-pattern questions

When the user asks for task-iteration command patterns, the answer should contain:
1. one **GENERATE** block using companion `session new`
2. one **FIX LOOP** block using companion `session continue "$GENERATOR_SID"`
3. one **RE-EVALUATE** block using companion `session continue "$REVIEWER_SID"`
4. one sentence explaining why session reuse matters

Do not answer with made-up phase-specific commands.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<generator-prompt>"
```

If you want non-blocking execution, you may use the companion background-job layer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --background \
  --timeout 60 \
  -- "<generator-prompt>"
```

If you use `--background`, record `GENERATOR_JOB_ID` and later retrieve the session id from the result/output before the fix loop begins.

5. Record the returned session id as `GENERATOR_SID`.
6. If the run times out or the stream drops **after** yielding a session id, prefer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session attach "$GENERATOR_SID" \
  --directory "$WORK_DIR" \
  --timeout 5
```

Do not submit a duplicate implementation run unless reuse is no longer reliable.

**Exit criteria:** Initial implementation finishes and `GENERATOR_SID` is recorded.

## Phase 4: EVALUATE

Run an independent evaluation against the deliverable standard.

1. Load `references/prompt-templates.md` and use the **Initial Evaluation** template.
2. Compose a fresh Reviewer prompt grounded in:
   - deliverable standard
   - test scenarios
   - authority references
   - file scope
3. Keep this lane evaluation-only — no code changes.
4. Dispatch to a **fresh** companion session (do not reuse `GENERATOR_SID`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<reviewer-prompt>"
```

5. Record the returned session id as `REVIEWER_SID`.
6. Classify findings:
   - `PASS` — no Critical or High findings
   - `PASS_WITH_NOTES` — only Medium / Low findings
   - `FAIL` — one or more Critical / High findings

If the reviewer run drops after producing a session id, attach to the same reviewer session before relaunching.

**Exit criteria:** Evaluation completes and findings are classified.

## Phase 5: FIX LOOP

Iterate until clean or rounds exhausted.

Only enter this phase when Phase 4 returns `FAIL`.

```
round = 0
while findings == FAIL and round < max_fix_rounds:
    round += 1
    → resume GENERATOR_SID with fix prompt
    → resume REVIEWER_SID with re-evaluation prompt
    → classify findings
    if PASS or PASS_WITH_NOTES: break
```

### Fix iteration

1. Load `references/prompt-templates.md` and use the **Fix Iteration** template.
2. Resume the generator session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session continue "$GENERATOR_SID" \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<fix-prompt>"
```

3. Include `{{REVIEWER_FINDINGS}}` plus the whole feature context again so the generator understands why each fix matters.
4. After the generator completes, resume the reviewer session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session continue "$REVIEWER_SID" \
  --directory "$WORK_DIR" \
  --timeout 60 \
  -- "<re-eval-prompt>"
```

5. If either run drops after yielding a session id, attach to the same session before launching fresh work.
6. Reclassify findings.
7. If `round == max_fix_rounds` and the result is still `FAIL`, escalate to the user with explicit options.

**Exit criteria:** Reviewer returns `PASS` / `PASS_WITH_NOTES`, or the user explicitly accepts the residual issues.

## Phase 6: ADVISORY

Run the final adversarial gate against the full diff.

1. Generate the diff scope:

```bash
git diff "$BASE_REF"..HEAD --stat
```

2. Run the direct companion review command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" review \
  --directory "$WORK_DIR" \
  --adversarial \
  --scope branch \
  --base "$BASE_REF" \
  --wait
```

3. If the review surface is unavailable, dispatch to a fresh OpenCode companion session using the **Advisory Review** template from `references/prompt-templates.md`.
4. If Critical or High findings remain:
   - do one more generator fix round by reusing `GENERATOR_SID`
   - re-run advisory once
   - do not loop forever

**Exit criteria:** Advisory returns no Critical / High findings, or the user explicitly accepts the remaining issues.

## Phase 7: DONE

Finalize and verify completeness.

1. Cross-check every checklist item from the exec-plan against the implementation.
2. Update the exec-plan checklist items.
3. Verify documentation consistency:
   - authority references still match implementation
   - terminology is consistent
   - no stale examples remain
4. If doc gaps exist, update them in Claude by default.
   Only send a doc step to OpenCode if it is a clearly mechanical, code-coupled transformation.
5. Present a completion summary:
   - files changed
   - checklist items satisfied
   - advisory status
   - any accepted residual issues

**Exit criteria:** Checklist complete, docs consistent, summary delivered.

---

## Runtime safety rules

- There are no phase-specific task-iteration entrypoints. When the user asks for command patterns, show direct companion script calls.
- When the user asks for phase command patterns, show the actual companion `session new` / `session continue` / `session attach` patterns from this skill.
- Do not use raw `opencode run` in this workflow.
- Prefer companion-managed `session` / `job` flows.
- Treat session reuse as the default path for fix loops.
- Treat timeouts as ambiguous until attach / verification says otherwise.
- Do not confuse progress signals with completion.
- Verify artifacts, diffs, and validation output before advancing phases.

## Error handling

- **Companion / serve not ready:** use the OpenCode runtime setup/check flow before Phase 3.
- **Session id invalid after a serve restart:** start fresh sessions and explicitly carry forward the relevant context.
- **Background job still running:** use companion `job status` / `job result` rather than guessing.
- **Fix loop exhausted:** always escalate to the user.

## Integration notes

- Use direct `session new` / `session continue` companion script calls for one-off execution lanes.
- Continue or attach to the same companion session with a narrow rescue prompt for rescue flows.
- This skill should follow the hidden orchestrator skill's ownership rules rather than redefining them.
