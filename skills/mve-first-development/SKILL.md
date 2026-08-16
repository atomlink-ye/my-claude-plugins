---
name: mve-first-development
description: "Use whenever planning, implementing, testing, or reviewing early-stage product work, greenfield features, unstable contracts, spikes, prototypes, vertical slices, MVP/MVE delivery, or requests to get the minimum real path working. Route the work through Shape, Probe, Prove, Protect, and Harden; default to Prove/MVE when the user or project does not declare a stage. Prevent premature TDD, contract freezing, broad mock-based E2E suites, and production hardening before one real end-to-end path exists."
---

# MVE-First Development

Use this skill to choose the **right delivery discipline for the current level of uncertainty**. Early product work and production work should not be forced through the same process.

Default rule: **when the stage is not explicit, use `Prove` (MVE-first)** and cut scope until one real, observable end-to-end path can run. Use a narrow `Probe` only when one unresolved technical question blocks that path.

This is not an anti-testing skill. It delays expensive contract protection until there is an accepted behavior worth protecting.

## Core Rule

**Fix the appetite; vary the scope.**

Set a bounded amount of time and attention before designing the solution. Inside that appetite:

- solve the smallest meaningful problem
- prefer one integrated vertical slice over many completed horizontal layers
- keep the solution rough enough to change and bounded enough to finish
- call out rabbit holes and explicit no-gos
- cut scope before adding time, abstraction, or test matrices
- stop when the stage exit condition is met

Do not confuse a detailed plan with reduced uncertainty. In R&D work, learning often comes from building against the real boundary.

## Stage Router

| Stage | Main question | Default work | Validation | Exit condition |
|---|---|---|---|---|
| `Shape` | What problem is worth this appetite? | Baseline, outcome, rough solution, rabbit holes, no-gos | Review the framing and key risks | The work is rough, solved enough, and bounded |
| `Probe` | Can the highest-risk assumption work? | One time-boxed spike against the real unknown | Direct experiment and captured evidence | The question is answered well enough to choose or reject an approach |
| `Prove` | Can the smallest real user/system path work end to end? | One fixed scenario and the thinnest vertical slice | One real canary plus minimal checks | The real path runs, the result is observable, and no blocker invalidates it |
| `Protect` | Which observed behavior is now accepted and must survive change? | Characterization tests, focused regressions, contract convergence, refactoring | Tests derived from real runs and known failures | Accepted behavior has a useful regression safety net |
| `Harden` | Is the system ready for external users and operational commitments? | Security, reliability, recovery, performance, migrations, runbooks, release evidence | Full risk-appropriate suites and release gates | The declared production/release bar is met |

### Selection precedence

1. Follow an explicit user instruction about the stage or required method.
2. Follow a canonical project stage when one is declared.
3. Route release, regulated, destructive, security-critical, or already-consumed stable contracts to `Protect` or `Harden`.
4. Route greenfield work with unstable behavior to `Prove`; insert a `Probe` only for the blocking unknown.
5. When still ambiguous, choose `Prove`.

A project may contain mixed stages. A settled authentication boundary may be in `Harden` while a new agent workflow remains in `Probe` or `Prove`.

## Shape-Up Principles Adapted for Agent Work

### Appetite, not estimate

Declare how much time the question deserves before expanding the design. An appetite is a constraint on the solution, not a prediction of how long a preselected solution will take.

### Rough, solved, bounded

Do enough shaping to identify the core interaction and technical path, but do not freeze speculative API fields, tables, abstractions, or edge-case behavior. Detail only the risky spots that could trap the implementation.

### R&D mode accepts scrapwork

When core behavior and architecture are unsettled, disposable code is allowed. Optimize for learning and an integrated demonstration, not for preserving every early implementation.

### Get one piece done

Make one tangible slice work early. Avoid building models, adapters, UI shells, and test scaffolds separately with integration deferred until the end.

### Scope hammering

When the work is too large, question every use case and implementation detail:

- Can one tenant, user, provider, workspace, or message type prove the idea?
- Can a fixed configuration replace a registry for now?
- Can plain text replace cards, rich UI, or generalized schemas?
- Can a manual step remain until the core path is proven?
- Can a feature move to the deferred ledger without invalidating the result?

### Hill status

Report uncertainty, not percentage complete:

- `thought-about`: an approach exists only in theory
- `validated`: the approach touched the real boundary
- `known`: meaningful unknowns are resolved; execution remains
- `done`: the stage exit condition is met

Do not call a scope downhill merely because a design document is detailed.

### Circuit breaker

If the appetite expires without meeting the exit condition, stop by default. Record what was learned, cut or reshape the approach, and make a new bet. Do not automatically extend the task because work has already been invested.

## Minimal Planning Contract

For early work, prefer this compact contract over a large speculative task breakdown:

```yaml
stage: prove
appetite: <time or effort budget>

# Authority — freeze this BEFORE implementation, or the work reopens closed decisions
authority: <the canonical decision source: which doc, which spec, which contract>
base_revision: <branch @ commit sha the work starts from>
settled: []          # decisions that are closed; seeing an older doc does not reopen them
still_open: []       # what may still be re-argued

baseline: <what happens without this change>
outcome: <the one result this stage must prove>
real_path: <real entry -> application/core -> real boundary -> observable result>
highest_unknown: <the assumption most likely to invalidate the path>
scope_now: []
no_gos: []
rabbit_holes: []
canonical_smoke: <command or exact runbook>
exit_condition: <minimum evidence that ends the stage>
hill_status: <thought-about|validated|known|done>
deferred:
  feature: []
  hardening: []
  questions: []
```

Do not create an exhaustive backlog before touching the real work. Prefer discovered tasks over imagined tasks.

**Freeze the authority first.** Without an explicit `authority` / `base_revision` / `settled` block, a long task drifts: an older design doc surfaces mid-implementation and a decision that was already closed gets reopened, silently, with no one deciding to reopen it. Naming the settled set is what makes that drift visible.

## Stage Workflows

### Shape

Produce only what is needed to make a sensible bet:

1. State the problem and current baseline.
2. Set the appetite.
3. Sketch the core elements and connections at low fidelity.
4. Identify rabbit holes that could consume the appetite.
5. Declare no-gos and unsupported use cases.
6. Stop before implementation details become speculative contracts.

### Probe

Use a probe to answer one question, not to build a disguised subsystem:

1. Write the question and pass/fail observation.
2. Touch the real dependency, runtime, provider, database, device, or protocol.
3. Use the shortest reversible implementation.
4. Capture command, input, output, logs, IDs, and limitations.
5. Decide: adopt, adapt, reject, or probe again with a narrower question.
6. Delete or clearly label disposable code when it should not become a foundation.

A probe does not need a regression suite unless it protects an irreversible safety boundary or reproduces a real defect.

### Prove — default MVE mode

Build the smallest meaningful vertical slice:

1. Fix one representative user/system scenario.
2. Use one real entry point and at least one real critical boundary.
3. Implement only the state and interfaces needed for that path.
4. Produce one observable final result or artifact.
5. Leave one canonical smoke command or exact runbook.
6. Capture minimal evidence and a deferred ledger.
7. Stop as soon as the exit condition is met.

Hard-coded test identities, one provider, one workspace, one message type, or a manual setup step are acceptable when they are explicit, reversible, and do not falsify the result.

### Protect

Protect behavior after it has been observed and accepted:

1. Start from real transcripts, traces, artifacts, bug reports, and stable examples.
2. Add characterization tests for behavior the team intends to preserve.
3. Add focused regressions for defects that actually occurred or risks now made concrete.
4. Converge contracts only where a real consumer depends on them.
5. Refactor behind the safety net.
6. Remove experimental shortcuts that now obstruct maintainability.

Do not invent a broad idealized contract suite disconnected from the behavior the product actually chose.

### Harden

Apply the production bar appropriate to the risk:

- deterministic unit and state-machine tests
- real database/service integration tests
- public API, event, tool, and provider contract tests
- critical user-journey E2E tests
- idempotency, retry, crash-window, and recovery tests
- security, authorization, secret, and tenant-isolation tests
- migration, compatibility, performance, capacity, and operability checks
- alerts, runbooks, rollback, audit, and release evidence

Hardening can cut product scope too. Production readiness is not an excuse to preserve every experimental feature.

## Long-Task Execution

Everything above decides *what* to build. This section decides *how to keep moving* when the work spans hours, sessions, or context compactions.

**Assume interruption is always possible.** The tool window can end, a container can reset, the context can be compacted. So durable state lives in git, PRs, and repo docs — never only in the conversation, an unsaved patch, or a scratch container. Create the branch, the roadmap/execution plan, and a draft PR *before* substantial changes, not as a finishing step: their purpose is recovery, not tidiness.

At all times keep four things explicit and writable down in one line each:

```text
CURRENT MAINLINE   what this whole round is for
CURRENT SLICE      the one boundary being moved right now
CURRENT PROOF      the cheapest check that would disprove it
NEXT ACTION        what happens the moment the current slice lands
```

If you cannot state all four, you are not blocked on code — you are blocked on framing.

### Semantic slices, not line counts

Never use "run tests every N lines". The unit of work is a **semantic slice: the smallest change that can explain by itself what it altered.** The test is whether it forms a complete verifiable concept:

```text
interface + implementation + one real caller
```

A slice may be 50 lines or 800. Length is not the variable. What matters is that one slice moves **one** boundary or establishes **one** invariant.

Per slice: `read only what this slice needs → change → prove → commit → push`. Do not combine an architecture change, a directory rename, a dependency upgrade, and a harness rewrite in one slice — when it breaks, nothing tells you which variable did it.

**Commit budget: one coherent slice = one checkpoint.** Not hourly, not at the end. Before committing ask: *if the work stopped right now, does this commit explain itself?* If yes, push it.

### Blocker triage — three kinds, three different responses

Classifying the failure matters more than fixing it fast. Getting the class wrong is what turns a 10-minute problem into an afternoon.

| Class | Looks like | Response |
|---|---|---|
| **Correctness blocker** | typecheck fails, this slice's core invariant fails, schema mismatch, partial state possible, ordering violated | **Stop and fix now.** Continuing corrupts every downstream signal |
| **Tool / environment blocker** | download path blocked, connector API unavailable, no real provider credential here, no browser/E2E env, Docker unavailable | **Change route, do not stop the task.** Downgrade to fake/contract/characterization, keep the deterministic work moving, and record the real run as *pending verification* |
| **Peripheral problem** | the neighbouring module is also ugly, a stale doc, a future edge case, unrelated lint debt | **Record, do not act** |

The middle row is the one most often mishandled in both directions: a missing E2E environment is not permission to fake evidence, and it is also not a reason to halt all deterministic progress.

### Budgets

These are soft budgets for judgment, not enforced timers.

**Retry budget — the same hypothesis, at most twice.** If two attempts fail and produce no new information, the third must change a variable: shrink the input, change the tool, read the source, move the observation point, build a different reproduction, or re-check the assumption. "Try again" is not a third attempt.

**Progress budget — stuck and slow are not the same thing.** The question is never "how long has this taken", it is **"did the last attempt produce new information?"** Three failures that each localize the problem further (type error → mapping error → repository boundary) is progress, even at 40 minutes. Three failures that are the same timeout with a different flag is stuck, even at 6 minutes. Stop the path that yields nothing new.

**Slice budget — 10–30 minutes for a normal slice.** Past that with no clear change, no known cause, and the same attempt repeating: the slice is too big or the blocker was misclassified. A genuine architecture/correctness blocker may exceed the budget, but it should then be **reduced to a minimal reproduction** rather than debugged in place — prove the invariant against fakes in isolation, then return to the mainline.

**Exploration budget — progressive disclosure, not "read the repo first".** Read the entry point, the port/contract, the core implementation, the direct callers, and the related tests. The moment that is enough to start the first slice, **stop expanding**. Load more per slice, on demand.

**Complexity budget — at most 1–2 large variables per round.** Architecture abstraction, DB migration, dependency upgrade, public API change, provider version bump, runtime behavior change, and test-harness change are each a large variable. Refactoring the architecture *and* upgrading the SDK in the same round means a failure cannot be attributed to either.

**Verification budget — full suites are not per-slice.**

| Level | What runs |
|---|---|
| Slice | typecheck + focused test |
| Milestone (several related slices) | module suite, integration |
| Convergence (mainline works) | repo deterministic verify, real DB, build |
| Handoff | every deterministic lane that *can* run, **plus an explicit list of what could not** |

**Failure budget — when moving on is allowed.**

Allowed: real E2E unavailable but the deterministic contract is verified; an unrelated baseline failure confirmed not caused by this change; an unimplemented hardening item that is an explicit non-goal; provider live-verification that requires the owner's environment while fake/contract/mapper coverage is complete.

Not allowed: typecheck failing; a core invariant not holding; callers not fully migrated to a new interface; partial state possible; silent data corruption possible; a failure whose cause is unknown *and* closely related to the change.

### Timeouts: unknown is not failed

A timeout means **the call did not return inside its window**. It does not mean the operation did not happen. So the response is decided by side-effect risk, not by impatience.

- **Read-only / idempotent** (typecheck, grep, query, unit test): narrow the scope, split it, raise the timeout once, rerun. Low risk.
- **Anything with an external side effect** (push, deploy, migration, external write, spawning an agent, submitting an order): **never retry by default.** Reconcile the external state first — did it happen? — *then* decide retry, continue, or compensate.

```text
timeout → side effects possible?
   no  → narrow / rerun
   yes → reconcile external state
           already succeeded → move on, do not repeat
           never executed    → safe to retry
           state unknown     → stop automatic retry, escalate
```

**A slow or timing-out full suite is a signal to decompose, not to raise the limit.** Ask which signal is actually needed, then find the smallest failing lane: typecheck, focused unit, affected module, contract, real-DB. If every focused lane passes and only the full suite hangs, that points at harness/environment/performance — do not declare the feature broken. But record it exactly as it is: **`full suite not completed`, never `all tests passed`.**

### Convergence — the phase most often skipped

The mainline working is not the end of the round. Run one explicit convergence pass:

- search for legacy references by name (old adapter names, old lookup helpers, `phase-`, `legacy`, `TODO`, `deprecated`)
- remove compatibility shims the new path made unnecessary
- **delete temporary migration tooling** — codemods, one-off generators, branch-only workflows are legitimate while refactoring, but the contract is `use → verify output → delete before handoff`. Left behind, every round permanently grows the harness debt
- naming cleanup, dead-code search
- broad deterministic verification
- read the complete diff as a diff, not as a memory of what you intended
- update the durable docs

## Testing Policy

In `Probe` and `Prove`, do **not** default to Red-Green-Refactor for behavior whose contract is still being discovered. Use this order:

```text
cheapest check needed to keep the experiment honest
-> one targeted real integration path
-> one real end-to-end canary
-> one critical invalidation case, only when it would make the result false or unsafe
```

**Run the cheapest test capable of disproving *this* change** — not the test that would prove the most.

```text
cheap  syntax / typecheck
   |   focused unit
   |   characterization
   |   module test
   |   integration / contract
   |   repo deterministic verify
   |   real DB
   |   real runtime
 costly real E2E
```

Pick by what the change could have broken, not by thoroughness. A pure mapper edit is disproved by one focused unit test; full E2E adds cost and no information. A change to session-binding persistence is disproved by the repository and resolver tests. The expensive rungs belong at milestone and convergence level, not after every slice.

A test is worth adding when it protects at least one of these:

- accepted product behavior
- a known failure or reproduced bug
- a stable interface with a real consumer
- an irreversible or high-risk safety invariant
- a refactor that would otherwise be unsafe

Mocks may accelerate local diagnosis, but they do not prove a real integration or MVE. A broad mock-based E2E suite before the real path runs is usually negative progress.

In `Protect` and `Harden`, TDD and broader regression suites are appropriate. If the user explicitly requests TDD earlier, honor that instruction while keeping the appetite and test surface narrow.

## 🔴 Prohibited by default: A/B tests and mutation arms

**Unless the Owner explicitly asks for a test, do not build one. Direct demonstration is sufficient.**

Specifically banned in `Probe` / `Prove` / `Protect` unless explicitly requested:

- **mutation arms / red arms** — "delete X, prove the check goes red"
- **A/B or differential harnesses** — running two variants to compare
- **negative-control matrices** — proving a criterion is not vacuously true
- **any work whose output is confidence in the instrument rather than a working path**

```text
✅ Can you directly demonstrate it works?   → demonstrate, ship
❌ Would it go red if broken?               → not asked, do not build
❌ Is this criterion precise enough?        → not asked, do not build
❌ Could something else make it green?      → not asked, do not build
```

The last three questions **recurse without bound**. Every answer creates a new instrument that
itself needs proving. One real round measured a **20:1 instrument-to-product commit ratio**
(59k lines under `scripts/` vs 1.1k under `src/`, most of that import renames) — and **not one
criterion ever went red during it**. The over-hardening accumulated entirely through steps that
were each individually correct.

### The one exception (do not over-correct)

If, **while running the direct demonstration**, you hit a green that lies about the product —
`exit 0` with zero tests executed, "succeeded" with no work done, a skipped step reported as passed —
**fix it**. In that case the demonstration itself is fake, so you have not demonstrated anything.

> **The distinction is: encountered during the demonstration, not constructed to go looking for it.**
> Never design a test to hunt for lying greens.

## Named over-hardening patterns (observed, not hypothetical)

Each of these was a *correct* finding that was nonetheless **wrong to pursue** at MVE stage:

| Pattern | What it looks like | Why it is off-path |
|---|---|---|
| **Criterion-precision recursion** | "This arm goes red, but for a reason broader than the claim" | Fixing it produces a better instrument, not a working product |
| **Classification depth** | Building tri-state `PASS/FAIL/MISSING` where two states suffice | Exit code 0 / non-0 plus a human-readable log is enough at this stage |
| **Simultaneity / provenance proofs** | Timestamp chains proving a control ran *during* a mutation; byte-level SHA binding of evidence | Proves the instrument is honest; proves nothing about the product |
| **Reachability / partition proofs** | Enumerating an outcome space and proving the classification is a partition | Formalizing the evidence system. Zero product change |
| **Retroactive audits** | "The rule changed, re-audit everything built under the old rule" | **Unbounded cost.** A corrected rule applies only to what is built *after* it |
| **Gate design for infrastructure** | Designing a provable admission gate for load/capacity/scheduling | Scheduling problem, not an engineering one. Retry or serialize instead |
| **Pre-paying next round's criteria** | Writing an assertion the current slice marks as vacuous | If the plan text says "vacuous this round", it does not belong in this round's gate |

## Early-warning signals that you are over-hardening

Both are cheap to measure and neither requires anyone's judgment:

1. **Instrument-to-product commit ratio.** Count commits touching `scripts/ | tests/ | ci/`
   against `src/ | app/ | lib/`. If the ratio exceeds roughly **3:1** over a work session, stop and re-read the roadmap's non-goals.
2. **Frequency of self-corrected criteria.** If you keep discovering that your *own* criteria measured
   the wrong thing, that is not a bad day — it is a readout that **you are building something too
   complex for you to get right**. Criterion error rate correlates with criterion complexity.
   In the round cited above, **8 self-corrections, all of them in the instrument layer, none in the product layer.**

**Also check the roadmap's own Non-Goals section before adding any instrument.** In that round,
`broad hardening` and `test coverage target` were listed there verbatim — the violation was of the
project's *explicit written non-goals*, not of an abstract principle.

## Review Policy

Classify every finding before deciding whether it blocks the current stage:

- `BLOCKER-NOW`: the real path cannot complete, the evidence is false, a critical boundary is bypassed, or the experiment creates an unacceptable safety/data risk
- `ENV-BLOCKED`: the work is correct but cannot be verified here (no credential, no runtime, no browser env). Route around it, keep the deterministic work moving, and carry it as *pending verification* — never as passed
- `DEFERRED-FEATURE`: useful for the next product slice but not required for the current proof
- `HARDENING`: reliability, recovery, security depth, performance, operability, edge cases, or polish for production
- `QUESTION`: unresolved decision with an explicit, reversible temporary path

In `Probe` and `Prove`, only `BLOCKER-NOW` is a required change by default. Review should answer:

1. Did the stage prove what it claimed?
2. Did a real user or system path actually run?
3. Is the result observable and reproducible?
4. Is the next stage unblocked?
5. Which findings belong in the deferred ledger?

Do not require every correct review suggestion to be fixed in the same slice.

## Timebox and Stop Rules

- At the midpoint, if no real path exists, hammer scope before adding abstractions or tests.
- When the appetite expires, stop and reshape instead of automatically extending.
- Within a stage, pace by the retry / progress / slice budgets in **Long-Task Execution** — the stop signal is "no new information", not elapsed time.
- When the exit condition is met, stop polishing and move to the next stage.
- When the same issue recurs, promote it from a note into a regression, lint, skill, tool contract, or architecture rule.

## Promotion Triggers

Move from `Probe` to `Prove` when the blocking unknown is resolved enough to choose a path.

Move from `Prove` to `Protect` when one or more are true:

- the owner accepts the observed behavior
- the path succeeds repeatedly
- a second consumer depends on it
- persistent data or migration semantics now matter
- a structural refactor is about to begin

Move from `Protect` to `Harden` when external users, production data, operational commitments, regulated behavior, or a release decision make failure costs material.

## Interaction with Other Skills

This skill owns **stage selection, appetite, scope, and validation intensity**.

- Use team-lead/orchestration skills for delegation after this skill defines the finish line.
- Use runtime companion skills for concrete execution commands.
- Apply TDD/test-generation skills by default only in `Protect` or `Harden`, unless the user explicitly requests them earlier.
- Apply security and release skills whenever risk demands them; MVE-first never overrides critical safety boundaries.

## Non-Goals

This skill does not:

- excuse unverifiable claims or fake integrations
- permit secrets, cross-scope data leaks, or unapproved destructive actions
- replace product judgment about whether the problem matters
- require six-week cycles or Basecamp tooling
- force every project to remain experimental
- prohibit tests; it makes them follow evidence and stage maturity

## Shape Up Source Notes

Adapted from the following Shape Up concepts:

- Set Boundaries: https://basecamp.com/shapeup/1.2-chapter-03
- R&D, Production, and Cleanup modes: https://basecamp.com/shapeup/2.3-chapter-09
- Risks, rabbit holes, and out-of-bounds scope: https://basecamp.com/shapeup/1.4-chapter-05
- Get One Piece Done: https://basecamp.com/shapeup/3.2-chapter-11
- Circuit breaker: https://basecamp.com/shapeup/2.2-chapter-08
- Hill Charts: https://basecamp.com/shapeup/3.4-chapter-13
