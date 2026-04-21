---
name: debug-workflow
description: Unified debug workflow skill for real-world issue reproduction, especially browser/UI/Web3 problems that need Playwright, shared Chrome/CDP, or agent-wallet. Use this whenever the user wants to confirm whether a workflow can reproduce real issues from walkthrough docs, issue lists, QA notes, or live bug reports. Start with the debug index, route to the right lane, and prefer deterministic local reproduction over fragile preview environments.
user-invocable: false
---

# Debug Workflow

This is the seed skill for an indexed debugging workflow.

Today it covers the **frontend / browser / wallet** lane well.
Later it should grow by adding more indexed lanes for:
- backend / API dependency debugging
- data-pipeline debugging
- auth / permission debugging
- environment drift / deployment debugging

## Core principle

Do not jump straight to fixing.
First decide whether the problem is:
1. **reproducible now**
2. **reproducible only with real browser state / wallet state**
3. **blocked by environment, preview auth, missing data, or dead upstream**

The main job of this skill is to turn vague bug reports or walkthrough notes into a **structured reproducibility verdict**.

## Debug index

Start here and route deliberately:

| Situation | Route |
|---|---|
| UI bug, route mismatch, missing button, rendering glitch, interaction regression | Read `references/frontend-playwright-agent-wallet.md` |
| Web3 connect flow, `window.ethereum`, wallet approval, signature popup, onchain dApp connect flow | Read `references/frontend-playwright-agent-wallet.md` |
| Walkthrough/QA doc needs to be converted into issue candidates with reproducibility status | Read `references/frontend-playwright-agent-wallet.md`, then use `templates/repro-report.md` |
| Backend / API / queue / DB dependency issue | Stay in this skill, note that a backend lane should be added, gather blockers and evidence instead of pretending frontend tools are enough |

## Standard workflow

### 1. Normalize the source of truth

Convert the user's raw input into a structured list:
- walkthrough doc items
- issue list
- screenshot-derived observations
- bug reports from chat or QA

For each item, capture:
- item id / title
- claimed symptom
- expected behavior
- candidate route / page / feature
- whether the source says fixed / unfixed / needs regression

### 2. Verify the environments before trusting them

Always check whether the reported environment is actually usable.

Examples:
- preview site redirects to login
- staging returns 404
- prod route exists but data is stale
- local dev server is the only viable reproduction surface

Do not promise reproduction on a broken preview URL.
Record the blocker and pivot to the best viable environment.

### 3. Prefer deterministic local reproduction

If a local repo can be started and exercised, prefer that over flaky hosted previews.

Typical order:
1. local dev server
2. stable staging/prod route
3. protected preview only if auth is available

### 4. Choose the browser lane intentionally

For frontend reproduction, default to **Playwright / browser MCP** because it is better for:
- repeatable navigation
- screenshot capture
- structured evidence
- future regression automation

Use a lighter browser operator only for quick exploration, not as the primary reproduction harness.

### 5. Add wallet state only when the bug truly needs it

If the issue can be reproduced without a wallet, do not introduce wallet complexity.

Only switch to the wallet path when the issue depends on:
- wallet connect UI
- provider detection
- signing / approval queue
- chain switching
- account state inside the dApp

### 6. Produce a verdict, not hand-wavy notes

Every investigated item should end in one of:
- `reproduced`
- `not_reproduced`
- `blocked`
- `needs_more_context`

And every verdict needs evidence.

## Required output shape

For multi-item debug tasks, produce a markdown report using `templates/repro-report.md`.

Minimum sections:
- source doc / source issue list
- issue candidate mapping
- reproduction matrix
- evidence
- blockers
- workflow judgment

## Rules for honesty

- If the preview is behind login, say so.
- If the route does not exist locally, say so.
- If data dependencies are missing, say so.
- If you only proved page load and not the original business bug, say so.

A precise blocker is better than fake confidence.

## Extension model

This skill should grow by **adding indexed references**, not by turning SKILL.md into a giant blob.

Good future additions:
- `references/backend-api-dependency-debug.md`
- `references/data-pipeline-debug.md`
- `references/auth-and-permission-debug.md`
- `references/deployment-drift-debug.md`

Keep this top-level skill as the router and shared operating model.

## Pitfalls

- Treating a protected preview as a valid reproduction target without checking auth first.
- Using wallet tooling for every issue, even when no wallet state is needed.
- Confusing "page loads" with "bug reproduced".
- Jumping from walkthrough notes directly to implementation without a reproducibility pass.
- Failing to record blockers explicitly.

## Success criteria

This skill is working if it helps you answer:
- Which reported problems are real and reproducible now?
- Which ones are blocked by environment or missing dependencies?
- Which ones need browser-only evidence vs wallet-aware evidence?
- Which items are strong enough to become actionable issues?
