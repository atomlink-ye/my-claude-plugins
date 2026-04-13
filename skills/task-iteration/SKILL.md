---
name: task-iteration
description: "Orchestrate end-to-end feature implementation from an exec-plan document. Delegates coding to OpenCode, runs independent evaluation, loops fixes until clean, and gates completion on an advisory review. Use when the user says 'implement feature', 'execute plan', references an exec-plan path, or wants the Plan-Generate-Evaluate workflow for a structured feature."
user-invocable: true
---

# Task Iteration

Orchestrate feature implementation from exec-plan documents using the Plan → Generate → Evaluate workflow.

**Invocation:** `/task-iteration <exec-plan-path> [feature-identifier] [--max-fix-rounds N]`

## Overview

Seven phases run in sequence. Coding and evaluation are delegated to OpenCode sessions that persist across fix iterations. The orchestrator (Claude Code) holds the vision, tracks session IDs, and gates transitions.

```
PARSE → PLAN → GENERATE → EVALUATE → FIX LOOP → ADVISORY → DONE
                       ↓           ↑
                       └── up to N ┘
```

## Key principles

- **Generator = Fixer.** One OpenCode session (`GENERATOR_SID`) handles initial implementation and all subsequent fix iterations. It holds warm file state.
- **Reviewer stays independent.** A separate session (`REVIEWER_SID`) evaluates the Generator's output. It never sees the Generator's internal reasoning — only the code and the review criteria.
- **Whole picture, scoped work.** When delegating to OpenCode, include the full feature context (spec, deliverable standard, authority refs, file scope) so the subagent can make informed decisions, but restrict its output to only the work within its scope.
- **Background by default.** GENERATE and EVALUATE dispatch via `run_in_background: true`. Claude Code stays free to orchestrate.
- **Bounded fix loop.** Max 3 rounds with early exit on clean pass. If exhausted, escalate to user.

## Session tracking

| Session        | Created                         | Reused for                                           |
|----------------|---------------------------------|------------------------------------------------------|
| GENERATOR_SID  | Phase 3 (initial implementation)| All fix iterations (Phase 5), doc updates (Phase 7)   |
| REVIEWER_SID   | Phase 4 (initial evaluation)    | All re-evaluations (Phase 5)                         |
| Advisory       | Phase 6                         | Fresh OpenCode session each time (stateless review)  |

Store session IDs as local variables in the conversation. Pass them on subsequent OpenCode calls via `opencode run --session <sid>`.

---

## Phase 1: PARSE

Read the exec-plan and extract the target feature.

1. Read the exec-plan file at `<exec-plan-path>`.
2. Load `references/exec-plan-parsing.md` for extraction guidance.
3. Extract target feature data:
   - User story
   - Specification
   - Deliverable standard
   - Test scenarios
   - Checklist items
   - Authority references
4. If no `[feature-identifier]` given, list available features and ask user to select.
5. Record current git ref as `BASE_REF` for later advisory scoping:
   ```
   git rev-parse HEAD → BASE_REF
   ```
6. Present extracted summary to user for confirmation before proceeding.

**Exit criteria:** User confirms the extracted feature is correct.

## Phase 2: PLAN

Map the implementation surface and draft a plan.

1. Use a built-in Explore Agent to map affected files, interfaces, and existing patterns. Focus on:
   - Files that will be modified or created
   - Existing patterns to follow (naming, structure, error handling)
   - Interfaces that change
   - Test file locations
2. Draft a concise implementation plan (1–3 paragraphs). Cover:
   - What changes, where, and in what order
   - Risks or edge cases spotted during exploration
   - Any dependencies on other features (from Implementation Sequence in the exec-plan)
3. Present plan to user for approval.

**Exit criteria:** User approves the plan. This is the last human checkpoint before machines take over.

## Phase 3: GENERATE

Delegate initial implementation to OpenCode.

1. Load `references/prompt-templates.md`, use the **Initial Implementation** template.
2. Compose the OpenCode task prompt using the XML recipe. Inject:
   - `{{FEATURE_SPEC}}` — specification from exec-plan
   - `{{USER_STORY}}` — user story
   - `{{DELIVERABLE_STANDARD}}` — quality bar
   - `{{PLAN}}` — the approved plan from Phase 2
   - `{{FILE_SCOPE}}` — files identified in Phase 2
   - `{{AUTHORITY_REFERENCES}}` — authority docs from exec-plan
3. Include the **whole picture** in the prompt: full spec, deliverable standard, authority refs, and file scope. This lets the subagent make informed decisions. But explicitly restrict its output to only the files in scope — no speculative changes outside the feature boundary.
4. Dispatch to OpenCode:

   ```bash
   opencode run --session "" --title "implement: <feature-name>" "<prompt>"
   ```

   Use `run_in_background: true` in the Bash tool so Claude Code stays free.

5. Record the returned session ID as `GENERATOR_SID`.
6. Report file changes and completion status to user.

**Exit criteria:** Generator completes initial implementation. Session ID recorded.

## Phase 4: EVALUATE

Run independent evaluation against the deliverable standard.

1. Load `references/prompt-templates.md`, use the **Initial Evaluation** template.
2. Compose a fresh prompt for a **new** OpenCode session. Ground it in:
   - Deliverable standard from exec-plan
   - Test scenarios
   - Authority references
   - The file scope (so the reviewer knows what to examine)
3. Include the full feature context in the prompt so the reviewer can make informed judgments, but restrict its role to evaluation only — no code changes.
4. Dispatch to a fresh OpenCode session (do NOT reuse GENERATOR_SID):

   ```bash
   opencode run --session "" --title "review: <feature-name>" "<prompt>"
   ```

   Use `run_in_background: true`.

5. Record the returned session ID as `REVIEWER_SID`.
6. Classify findings:
   - **PASS** — no Critical or High findings
   - **PASS_WITH_NOTES** — only Low/Medium findings, feature is shippable
   - **FAIL** — one or more Critical/High findings

**Exit criteria:** Evaluation complete, findings classified.

## Phase 5: FIX LOOP

Iterate until clean or rounds exhausted.

Only entered when Phase 4 returns FAIL.

```
round = 0
while findings == FAIL and round < max_fix_rounds:
    round += 1
    → Resume GENERATOR_SID with fix prompt
    → Resume REVIEWER_SID with re-evaluation prompt
    → Classify findings
    if PASS or PASS_WITH_NOTES: break
```

**Fix iteration:**

1. Load `references/prompt-templates.md`, use the **Fix Iteration** template.
2. Resume the Generator session with reviewer findings:

   ```bash
   opencode run --session "$GENERATOR_SID" "<fix-prompt>"
   ```

   Inject `{{REVIEWER_FINDINGS}}` with the full findings from the last evaluation. Include the whole context again (spec, deliverable standard) so the Generator understands *why* each fix matters.

3. After Generator completes, resume the Reviewer session:

   ```bash
   opencode run --session "$REVIEWER_SID" "<re-eval-prompt>"
   ```

   Use the **Re-Evaluation** template. The reviewer verifies specific fixes and checks for regressions.

4. Classify new findings. If PASS or PASS_WITH_NOTES, exit loop.
5. If `round == max_fix_rounds` (default 3) and still FAIL, present remaining issues to the user for direction. Options:
   - Accept remaining issues and proceed to advisory
   - Continue fixing (reset round counter)
   - Abort

**Exit criteria:** Reviewer returns PASS / PASS_WITH_NOTES, or user accepts remaining issues.

## Phase 6: ADVISORY

Final quality gate — adversarial review of the full diff.

This is a hard gate. The feature is not done until advisory passes or the user explicitly accepts the findings.

1. Generate the diff scope:

   ```bash
   git diff "$BASE_REF"..HEAD --stat
   ```

2. Run adversarial review. Prefer the project's `review` command if available:

   ```bash
   review --adversarial --scope branch --base "$BASE_REF" --wait
   ```

   If `review` is not available, dispatch to a fresh OpenCode session with the **Advisory Review** prompt from `references/prompt-templates.md`. Include the full diff and the deliverable standard.

3. If Critical or High findings:
   - One more Generator fix round (resume `GENERATOR_SID`)
   - Re-run advisory
   - Repeat at most once (bounded — don't loop forever)
4. Present advisory output to user.

**Exit criteria:** Advisory returns no Critical/High findings, OR user explicitly accepts the remaining findings.

## Phase 7: DONE

Finalize and verify completeness.

1. **Checklist verification.** Cross-reference every checklist item from the exec-plan feature against the implementation. Each item must be demonstrably satisfied.
2. **Update exec-plan.** Mark completed items:

   ```
   - [ ] item → - [x] item
   ```

3. **Documentation consistency.** Verify:
   - Authority docs referenced in the feature are consistent with the implementation
   - Terminology matches what's used in the codebase
   - No orphaned references or stale examples
4. If doc gaps found, dispatch one more Generator task (resume `GENERATOR_SID`) to update docs.
5. Present completion summary:
   - Files changed
   - Checklist items satisfied
   - Advisory status
   - Any accepted residual issues

**Exit criteria:** All checklist items marked complete, docs consistent, summary presented.

---

## Error handling

- **OpenCode session fails to start:** Check `opencode serve` is running. Run `/opencode:setup` if needed.
- **Session ID becomes invalid (serve restart):** Start fresh sessions. Copy relevant context from the conversation into the new session's prompt.
- **User interrupts mid-phase:** Record current state (phase, session IDs, BASE_REF). Resume by re-invoking `/task-iteration` with `--resume` flag or by picking up from the last completed phase.
- **Fix loop exhausted:** Always escalate to user. Never silently accept a failing state.

## Integration with other skills

- `/opencode:task` — alternative dispatch mechanism for simpler tasks
- `/opencode:rescue` — if the Generator gets stuck on a hard problem
- `/opencode:setup` — ensure OpenCode is ready before Phase 3
- `/simplify` — optional post-advisory cleanup pass
