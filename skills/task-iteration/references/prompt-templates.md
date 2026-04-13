# Prompt Templates

Templates for composing OpenCode task prompts. Each template uses the XML recipe format (`<task>`, `<output_contract>`, `<follow_through>`) with `{{PLACEHOLDER}}` substitution.

## General rules for all prompts

- **Include the whole picture.** Every prompt must contain the full feature context: spec, deliverable standard, authority references, and file scope. The subagent needs this to make informed decisions within its scope.
- **Restrict to scope.** Every prompt must explicitly state what the subagent is allowed to change. No speculative changes outside the feature boundary.
- **No meta-commentary.** The subagent should not explain the prompt back — it should just do the work.

---

## 1. Initial Implementation

Used in Phase 3 (GENERATE).

```xml
<task>
Implement the following feature according to the specification and plan below.

## User story
{{USER_STORY}}

## Specification
{{FEATURE_SPEC}}

## Deliverable standard
{{DELIVERABLE_STANDARD}}

## Implementation plan
{{PLAN}}

## File scope
You MAY modify or create files within these paths only:
{{FILE_SCOPE}}

Do NOT touch files outside this scope. If you believe a change is needed outside scope, stop and report it rather than making the change.

## Authority references
{{AUTHORITY_REFERENCES}}
</task>

<output_contract>
- All files listed in the specification are created or modified
- Code follows existing patterns in the codebase (naming, structure, error handling)
- All test scenarios from the spec are covered by tests
- No files changed outside the declared file scope
- Build/lint passes (run relevant checks before finalizing)
</output_contract>

<follow_through>
If blocked on a design decision not covered by the spec, stop and report the ambiguity rather than guessing.
If a test fails after implementation, fix it within scope.
Before finalizing, verify: build passes, lint passes, tests pass.
</follow_through>
```

---

## 2. Fix Iteration

Used in Phase 5 (FIX LOOP). Sent to the Generator session.

```xml
<task>
Fix the following issues found during code review. Do NOT rewrite unaffected code.

## Feature context (for reference)
User story: {{USER_STORY}}
Deliverable standard: {{DELIVERABLE_STANDARD}}

## Reviewer findings
{{REVIEWER_FINDINGS}}

## File scope
You MAY modify files within these paths only:
{{FILE_SCOPE}}

## Rules
- Address every Critical and High finding
- For each fix, make the minimal change that resolves the issue
- Do not refactor surrounding code unless the finding explicitly requires it
- After fixing, verify: build passes, lint passes, tests still pass
</task>

<output_contract>
- Every Critical and High finding is addressed
- No regressions introduced (existing tests still pass)
- Changes are minimal and focused on the findings
- Build/lint/test all pass
</output_contract>

<follow_through>
If a finding is unclear or you disagree with it, fix what you can and report the disagreement — do not silently skip it.
If a fix requires changes outside the file scope, report it rather than making the change.
</follow_through>
```

---

## 3. Initial Evaluation

Used in Phase 4 (EVALUATE). Sent to a fresh Reviewer session.

```xml
<task>
Review the implementation of the following feature against its deliverable standard. You are an independent reviewer — you did not write this code.

## Feature context
User story: {{USER_STORY}}
Specification: {{FEATURE_SPEC}}
Deliverable standard: {{DELIVERABLE_STANDARD}}
Test scenarios: {{TEST_SCENARIOS}}

## Authority references
{{AUTHORITY_REFERENCES}}

## File scope (examine these files)
{{FILE_SCOPE}}

## Review instructions
1. Read every file in the file scope
2. Check each deliverable standard item — is it satisfied?
3. Check each test scenario — is it covered by tests?
4. Check for: correctness, edge cases, error handling, consistency with existing patterns
5. Check documentation: are authority docs consistent with the implementation?

## Output format
Classify each finding by severity:
- **Critical**: Wrong behavior, data loss, security vulnerability
- **High**: Missing required behavior, broken test, spec violation
- **Medium**: Suboptimal but functional, missing non-critical test
- **Low**: Style, naming, minor improvement

End with an overall verdict:
- **PASS** — no Critical or High
- **PASS_WITH_NOTES** — only Medium/Low findings
- **FAIL** — one or more Critical or High findings
</task>

<output_contract>
- Structured findings list with severity, location, description, and suggested fix
- Overall verdict (PASS / PASS_WITH_NOTES / FAIL)
- Evidence for each finding (quote the code, reference the spec line)
- No suggestions outside the file scope
</output_contract>

<follow_through>
If the code looks correct, say so — do not invent issues.
Focus on the deliverable standard and test scenarios. These are the ground truth.
</follow_through>
```

---

## 4. Re-Evaluation

Used in Phase 5 (FIX LOOP). Sent to the Reviewer session after the Generator applies fixes.

```xml
<task>
Re-evaluate the feature after fixes were applied. The previous review found these issues:

## Previous findings
{{REVIEWER_FINDINGS}}

## Feature context
Deliverable standard: {{DELIVERABLE_STANDARD}}
Test scenarios: {{TEST_SCENARIOS}}

## File scope
{{FILE_SCOPE}}

## Re-evaluation instructions
1. For each previous Critical/High finding, verify the fix:
   - Is the specific issue resolved?
   - Did the fix introduce any regression?
2. Re-scan the changed files for new issues
3. Re-check build/lint/test status if applicable

## Output format
Same format as initial evaluation. For each previous finding, state:
- RESOLVED — with evidence
- PARTIALLY_RESOLVED — what's still broken
- NOT_ADDRESSED — finding still present

End with overall verdict: PASS / PASS_WITH_NOTES / FAIL.
</task>

<output_contract>
- Status for each previous finding
- Any new findings (with severity)
- Overall verdict
- Evidence for all claims
</output_contract>

<follow_through>
Be fair — if a fix adequately addresses the finding, mark it RESOLVED even if the approach differs from what you suggested.
Do not raise new issues that are outside the deliverable standard or file scope.
</follow_through>
```

---

## 5. Advisory Review

Used in Phase 6 (ADVISORY). Dispatched to a fresh OpenCode session when the `review` CLI is not available.

```xml
<task>
Perform an adversarial review of the diff introduced by this feature implementation. You are a skeptical senior engineer looking for problems.

## Diff scope
Base ref: {{BASE_REF}}
Target: HEAD

Run: git diff {{BASE_REF}}..HEAD

## Feature context
Specification: {{FEATURE_SPEC}}
Deliverable standard: {{DELIVERABLE_STANDARD}}

## Review focus
1. **Correctness**: Does the diff do what the spec says? Any logic errors?
2. **Edge cases**: Missing null checks, off-by-one, unhandled errors?
3. **Security**: Injection, auth bypass, data exposure?
4. **Performance**: N+1 queries, unnecessary allocations, hot path concerns?
5. **Breaking changes**: Does this break any existing behavior? Are migrations needed?
6. **Test coverage**: Are the tests meaningful or just checking happy paths?

## Output format
- Findings with severity (Critical / High / Medium / Low)
- For each finding: file, line range, description, concrete fix suggestion
- Overall verdict: PASS (ship it) / FAIL (needs fixes)

Be adversarial. This is the last gate before the code ships.
</task>

<output_contract>
- Adversarial findings with evidence
- No hedging — call out real problems, don't invent them
- Overall verdict with reasoning
</output_contract>

<follow_through>
If the diff is clean, say so clearly. Don't pad the review with trivialities.
Focus on what could go wrong in production, not code style preferences.
</follow_through>
```
