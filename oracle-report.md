# ARCP Oracle report — architecture and operator fluency

Independent Claude Opus Oracle. Read-only, advisory, deferred. Not a review gate.

- Code read at `4fe6aaf` in worktree `arcp-document-first-convergence` (clean, no release SHA inspected).
- Operational inputs read: `.local/arcp-campaign/handoffs/fresh-manager-20260903.md` and `-progress.md`,
  `.local/arcp-portfolio/fresh-manager-20260903/producer-consumer-matrix.md` (the latency evidence),
  `.local/arcp-portfolio/fresh-manager-20260903/contracts/*`, `config/default.json`.
- No file named `CAMPAIGN.md` or `CONTEXT.md` exists anywhere under `~/.paseo` or `~/.claude`.
  I read the campaign handoff + progress pair as their referents and say so rather than inventing a source.
- **Read caveat:** during this review another agent began editing this same worktree —
  `control-panorama.ts` and its test are now dirty with a new `safeTitle` sanitizer that is not in
  `4fe6aaf`. Every line number below is pinned to `4fe6aaf` via `git show`, not to the working tree,
  so citations will be off by the size of that in-flight change if read against the current file.
  The `safeTitle` work is unrelated to the findings here and I have left it alone.

## Verdict

The primitives are good and unusually well reasoned. The *system* is not yet one system.

ARCP has two halves that do not touch. One half — `arcp.ts`, `state-store`, `channel-projection`,
`control-panorama`, `delivery-latency`, `document`, `supervision`, `steward` — is live, wired, and
serves HTTP. The other half — `sequence-model`, `sequence-projection`, `sequence-anomaly`,
`sequence-render`, `reporting-route` — is 684 lines (≈9% of source) with its own tests and **zero
production consumers**. The most valuable idea in the recent work sits in the dead half.

## Q1 — What is duplicated, too shallow, or still manual?

### D1. The contract-evidence distinction is only computed where nobody reads it *(highest leverage)*

`3165fbc` introduced verified / asserted / refuted contract evidence. It lives exclusively in
`sequence-projection.ts:59-63`, which nothing imports (`grep` for `sequence-projection` outside
its own tests returns nothing). Meanwhile `document.ts:resolveArtifactRef` — the mechanism that
makes the distinction meaningful — is called from exactly one place: `arcp.ts:1132-1137`, at
launch, once, throwing on failure.

Consequences:
- After launch, `contractRef` is a string on `RuntimeSession` (`arcp.ts:95`) that is never re-resolved.
  A revision row tampered with post-launch is undetectable on every live surface.
- `ControlPanorama` (`control-panorama.ts:56-71`) has **no contract field at all**. The one bounded
  read-only human surface cannot answer "is the thing running actually bound to a verified contract?"
- `contractBoundAtLaunch` (`arcp.ts:93`) is honestly documented as unverifiable-by-the-reader, and
  the projection that would downgrade it to `asserted` is unreachable.

This is document-first coordination that verifies once and then trusts a string. The comment on
`document.ts` ("a reader who does not trust the sender can still resolve it and prove the bytes are
the bytes it names") is true of the module and false of the system.

### D2. Two incompatible `ReportingRoute` types

- `arcp.ts:87` — flat: `{ launchedByMemberId?, primaryHandlerMemberId?, ccMemberIds[], escalationMemberIds[] }`.
  This is what `startManaged`, `launch`, `RuntimeSession` and the Paseo launch context actually carry.
- `sequence-model.ts` / `reporting-route.ts` — full: subject, ackPolicy, ackSlaMs, escalationChain,
  transition log, roster resolution, `reconcileReportingRoute`, `resolveReportingDecision`.

The rich one is unreachable: `State` (`arcp.ts:143`) has no `reportingRoutes` array, and nothing
outside `eval/.../domain/reporting-route.test.ts` imports it. `ArcpService` instead reimplements
escalation three separate times — `activateDeferredTakeovers` (2444), `escalateOverdueObligations`
(2491), `escalateToOwnerActor` (2556) — against the flat shape, without a transition log.

The dead module is the better design. The live paths are the shallow ones. Every takeover reason
that `reporting-route.ts` would have recorded as a durable typed transition is instead a free-text
`HandlerTakeover.evidence` string (`arcp.ts:91`).

### D3. Latency is measured on the wrong population

`delivery-latency.ts` is careful and correct about what it measures: `unknown` never collapses to
zero, safe-point wait is subtracted from transport. But `isOpen` (line 56) and
`isOpenObligation` (`control-panorama.ts:74`) both restrict to `ack_required | decision_required`.

The measured incident says the pain is elsewhere. From `producer-consumer-matrix.md`:
**all 16 open obligations are `consume_on_delivery`** — 11 stuck at `deliveryState:
undeliverable` (oldest 1.74h) and 5 still `queued`. Under the current predicates none of the 16
contributes to `pending.acks`, to `pending.decisions`, or to `oldestOpenObligationAgeMs`. A
panorama rendered against that state reads *"Open decisions: 0 / Open ACKs: 0 / Oldest open:
unknown"* while sixteen obligations are outstanding and eleven are permanently undeliverable.

Worse, `nextTriggerReason` then falls through to `idle_no_pending_work` — the exact false-green the
module header set out to prevent.

### D4. The measurements the operator actually needed are still hand-built

`producer-consumer-matrix.md` was generated by the Manager, not by ARCP. Its three most useful
dimensions have no code behind them:
- producer→consumer attribution (who owes whom),
- backlog classified by `kind / consumptionPolicy / deliveryState`,
- the oldest-age table.

`renderDeliveryLatency` emits one `slowest` sample and a duplicate-wake list. Median 1.01h, p90
9.39h, max 11.06h are recorded in the doc and computed nowhere in the codebase.

### D5. Campaign facts are re-typed by a human on every request

`ControlCampaignFacts` is honestly labelled caller-supplied. But the only supply route is query
string (`arcp-server.ts:163-165`): `campaignState`, `nextContractRef`, `nextLaunchBy`,
`stopAuthority`, `currentRound`, `checkpointSha`. Nothing persists them; there is no default.

So `nextTriggerReason: 'campaign_next_round'` is reachable only when the operator already knows the
next contract ref and types it into the URL. The panorama can tell you what you told it. Also two
`checkpointSha` fields coexist — one folded from Result evidence (`control-panorama.ts:108-110`),
one caller-asserted — with no reconciliation and no divergence signal.

### D6. Provider-budget source kinds duplicate the extension point they already have

`kind: 'command'` (`provider-budget.ts:81-82`) is a genuine, well-guarded plugin seam: absolute argv,
timeout, output cap, env allowlist, schema validation, and a trust-metadata cross-check that
refuses a collector claiming trust it was not configured for. `codexbar` and `pi-grok-cache` are
hardcoded special cases (`refreshProviderBudget`, `arcp.ts:1301`) that a `command` collector could
express. Two of the three shipped kinds are duplicates of the third.

### D7. `ArcpService` is a 2,530-line class with ~90 methods

Placement, launch, delivery pump, channel obligations, escalation, supervision, steward, documents,
budget and panorama all live on one object (`arcp.ts:598-3127`). `registerAdapter` alone spans
launch, safe-point, fact and result ingestion. The deep-module discipline visible in
`control-panorama.ts` and `delivery-latency.ts` has not reached the core.

## Q2 — Can a user add adapters or fact sources without changing core?

**Fact sources: yes.** The `command` collector is the model. Declare it in config, ship any
executable that emits a `ProviderBudgetEnvelopeV1`; no rebuild, no core edit. This is the one
finished extension seam in the system.

**Actor channels: no.** `registerConfiguredChannels` (`arcp.ts:962-969`) hard-refuses any provider
that is not the literal string `'builtin:hermes'`. `ActorChannelRegistry` is a clean startup-only
registry with duplicate-fails-closed semantics, and `RecordingChannelAdapter` proves the seam with a
second implementation — but there is no path from config to a user module. The comment on
`actor-channel.ts:105` ("other channels are user modules loaded through the same registry")
describes an intent the loader does not implement.

**Runtime adapters: no.** Three separate blockers:
1. `server.ts:146` — the production entrypoint and package `main` — constructs `new ArcpService(dataDir)`
   with no adapters argument. The `adapters` constructor parameter and `registerAdapter` are reachable
   only from tests or an in-process embedder. There is no config key for runtime adapters at all.
2. `adapterFor` (`arcp.ts:690`) hardcodes `'paseo'` and `'hermes-acp'` as the fallback resolution.
   A third adapter is reachable only if every session row already names it.
3. The `RuntimeAdapter` interface (`arcp.ts:119-132`) **understates its own contract**. The three
   ingestion hooks that make an adapter useful — `onSafePoint`, `onFact`, `onResult` — are reached
   through structural casts in `registerAdapter` (`arcp.ts:626-630`) and appear nowhere in the
   interface. A third-party author reading the type cannot discover that publishing a Result is even
   possible, and gets no type checking on the payload shape if they guess correctly.

Net: one of three extension axes is real.

## Q3 — Can a human see active work, decisions, reasons, next trigger, and backlog?

`GET /v1/workspaces/{id}/control-panorama?format=markdown` is a genuinely good surface and the right
shape: one bounded read, pure fold, `nowMs` as a fact, renderer and JSON sharing one projection so
they cannot drift, and `UNKNOWN` never collapsed to a plausible value.

| Question | Answer |
|---|---|
| Active work | **Yes** — runtimes table with role, provider, state; goal/task/latest result. |
| Decisions | **Partly** — counts of open decisions/ACKs, and `latestDisposition` with actor and timestamp. Only the single latest; no history. |
| Reasons | **Partly** — reason text is carried, but decision reasons are capped at 240 chars by `boundedReason` (`arcp.ts:174`). The campaign already paid for this: `event_manager-integration:decision` carries the durable verdict summary `"probe"` because three fully-reasoned attempts were refused and `resolveDecision` is idempotent. The real rationale lives in a Knowledge entry the panorama does not show. |
| Next trigger | **Yes for control-plane state, no for campaign state** — see D5. The ranking (human obligation > agent work > campaign queue) is right, and "idle is never completion" is correctly enforced via `unresolvedTask`. |
| Backlog | **No.** There is no backlog dimension. `task` is the newest session's task only; the other tasks in the workspace are never listed. `deferred` obligations, `nextVisibleAt`, and dependency-blocked events do not surface. And per D3 the 12 undeliverable obligations are counted nowhere. |
| Contract binding | **No.** See D1. |

The honest summary: a human can see *what is running* and *what is formally owed*. They cannot see
*what is queued*, *what is stuck*, or *what authority the running work is under*.

## Q4 — Three next MVE outcomes, ranked by leverage

### MVE-1 — Wire the contract evidence into the panorama
**Outcome:** `ControlPanorama` carries `contract: { ref, evidence: 'verified'|'asserted'|'refuted'|'none', documentId, revision }`
per runtime, re-resolved from `state.documentRevisions` at projection time, and the Markdown renders
it. `refuted` forces `nextTriggerReason` to a new owner-attention reason.

**Why first:** it is the smallest change that makes document-first *true at read time* rather than
only at launch time, and it converts a dead 684-line subsystem into a live one by lifting the one
function that matters (`sequence-projection.ts:57-64`) into `control-panorama.ts`. Pure fold, no new
state, no new I/O, testable with the existing `document-artifact` fixtures. Everything else in the
document-first thread is decoration until a reader can see the evidence class.

**Done when:** a runtime whose bound revision body is mutated in the store renders `refuted` without
any process restart or `refresh=1`.

### MVE-2 — Make backlog and stuck obligations first-class in the panorama
**Outcome:** widen `isOpenObligation` to include any event that is not terminally disposed —
crucially `consume_on_delivery` at `deliveryState: undeliverable` or `queued` — and add a `backlog` section
grouped by `kind / consumptionPolicy / deliveryState` with an oldest-age list, plus deferred
obligations with their `nextVisibleAt`. Keep `pending.acks` / `pending.decisions` as they are so the
obligation semantics stay clean; add `pending.stuck` beside them.

**Why second:** this is the one finding with hard measured evidence behind it — all 16 open
obligations invisible, 11 of them undeliverable, oldest 1.74h — and it closes the false `idle_no_pending_work` path. It also
retires most of the hand-built matrix by making ARCP compute what the Manager computed by hand.
Same pure-fold shape as MVE-1; no new tables.

**Done when:** the panorama rendered against a state resembling the recorded 93-event workspace
reports 11 stuck and 5 queued obligations and does **not** report `idle_no_pending_work`.

### MVE-3 — One real third-party RuntimeAdapter loaded from config
**Outcome:** promote `onSafePoint` / `onFact` / `onResult` to optional members of the
`RuntimeAdapter` interface (deleting the structural casts in `registerAdapter`); add
`adapters.runtimes[]` to `config/default.json` mirroring the `actorChannels` shape; have `server.ts`
resolve and pass them into the `ArcpService` constructor; and make `adapterFor` resolve through the
registry with a single explicit default instead of two hardcoded ids.

**Why third:** it is the only one of the three that changes what a *user* can do, and the
`command`-collector seam already proves the team knows how to build a safe loader — the shape is
established, it just has not been applied to the adapter axis. Doing it after MVE-1/2 means the new
adapter's Results land on a panorama that can actually show whether they were contract-bound.

**Done when:** a recording adapter declared only in a config file publishes a Result and a fact that
appear in the panorama, with no edit to `arcp.ts` or `server.ts`.

## Deferred, not proposed

Recorded because they are real, but below the line for the next three MVEs:

- Split `ArcpService`. Placement/launch, obligations/escalation, and documents are three modules.
  Large, risky, and it does not unblock an operator today.
- Reconcile the two `ReportingRoute` types by persisting the rich one and deleting the flat one.
  Correct, and probably the right end state — but it is a state-schema migration, not an MVE.
- Fold `codexbar` and `pi-grok-cache` into `command` collectors shipped as scripts.
- Raise or restructure the 240-char `boundedReason` cap for decision summaries, or make the
  panorama surface the linked Knowledge entry. The campaign has already lost one verdict rationale
  to this.
- `setHermesTransport` (`arcp.ts:997-1007`) iterates every unavailable `channelStatus` entry and
  registers a `HermesChannelAdapter` for each; with two configured-but-unavailable channels the
  second iteration would hit `register`'s duplicate-id throw. Unreachable with the shipped
  single-entry config — flagged only so it is not discovered later as a mystery.

## Evidence pointers

| Claim | Location |
|---|---|
| Contract evidence computed only in dead code | `runtime/src/sequence-projection.ts:57-64`; no importer outside `eval/.../domain/` |
| `contractRef` never re-resolved after launch | `runtime/src/arcp.ts:1132-1137` (only `resolveDocumentRef` call), `:1563-1564` |
| Panorama has no contract field | `runtime/src/control-panorama.ts:56-71` |
| Two `ReportingRoute` types | `runtime/src/arcp.ts:87` vs `runtime/src/sequence-model.ts` + `reporting-route.ts` |
| Rich route unpersisted | `runtime/src/arcp.ts:143` (`State` has no `reportingRoutes`) |
| Escalation reimplemented three times | `runtime/src/arcp.ts:2444`, `:2491`, `:2556` |
| Open-obligation predicate excludes undeliverable | `control-panorama.ts:74`, `delivery-latency.ts:56` |
| 11 of 16 open obligations undeliverable, other 5 queued, oldest 1.74h | `.local/arcp-portfolio/fresh-manager-20260903/producer-consumer-matrix.md` § Backlog |
| Latency percentiles hand-computed | same file § Obligation latency (median 1.01h, p90 9.39h, max 11.06h) |
| Campaign facts arrive by query string | `runtime/src/arcp-server.ts:163-165` |
| Actor-channel loader refuses non-builtin | `runtime/src/arcp.ts:962-969` |
| No adapters passed at production startup | `runtime/src/server.ts:146` |
| Adapter fallback hardcodes two ids | `runtime/src/arcp.ts:690` |
| Ingestion hooks absent from the interface | `runtime/src/arcp.ts:119-132` vs `:626-630` |
| `command` collector seam (the model to copy) | `runtime/src/provider-budget.ts:82`, `config/default.json` § providerBudget.sources |
| 240-char decision summary cap, and its cost | `runtime/src/arcp.ts:174`; `.local/arcp-campaign/handoffs/fresh-manager-20260903-progress.md` § Known record defect |
