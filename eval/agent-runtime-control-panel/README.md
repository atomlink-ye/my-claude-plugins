# ARCP evaluation architecture

The ARCP evaluation suite is organized by the boundary being proved, not by
production source file. Tests remain outside the shipped runtime and the
default command is hermetic: it never starts a real Paseo daemon or provider.

## Layers

| Layer | Location | What belongs here | Canonical command |
| --- | --- | --- | --- |
| Domain | `tests/domain/` | Pure rendering and projection over supplied facts and time. | `pnpm --dir skills/agent-runtime-control-panel/runtime test:domain` |
| Persistence | `tests/persistence/` | State-store and archive/migration durability. | `pnpm --dir skills/agent-runtime-control-panel/runtime test:persistence` |
| Application | `tests/application/` | Service workflows, policy, restart and in-process loopback behavior. | `pnpm --dir skills/agent-runtime-control-panel/runtime test:application` |
| Adapters | `tests/adapters/` | Child-process and collector boundaries against controlled local fixtures. | `pnpm --dir skills/agent-runtime-control-panel/runtime test:adapters` |
| Contracts | `tests/contracts/` | Broad HTTP/CLI/TUI control-plane characterization. | `pnpm --dir skills/agent-runtime-control-panel/runtime test:contracts` |
| Canary | `tests/canary/` | Operator-supplied campaign-state checks; never part of the default suite. | `ARCP_CAMPAIGN_STATE=/path/to/state pnpm --dir skills/agent-runtime-control-panel/runtime test:canary` |

`contracts/control-plane.test.ts` intentionally remains broad while it
characterizes pre-existing behavior across service, HTTP, CLI and TUI seams.
It is a migration-safe transitional suite, not a claim that those boundaries
are unit tests. Add a new test at the narrowest layer that can prove its
behavior; keep a cross-boundary regression there only when the interaction is
the behavior under test.

`tests/support/` contains the small reusable seam shared by service tests:
`FakePaseoCli` records the ARCP-owned Paseo command boundary,
`createControl` initializes an in-process service, and the named Lane C facts
are a semantic fixture shared by projection layers. Adapter-specific fake
behavior and clock fixtures stay local to their suites so this does not become
a general-purpose test DSL.

## Execution and boundary honesty

Run the complete deterministic suite with:

```sh
pnpm --dir skills/agent-runtime-control-panel/runtime test
```

The adapter tests spawn only controlled local fixtures. The timeout test is
slow by design but hermetic; it is not a live Paseo test. `test:canary` is
explicitly external-state dependent and fails without `ARCP_CAMPAIGN_STATE`.
It provides manual campaign-state confidence only and must not be described as
live-provider coverage.

## R0–R3 / A0–A3 assessment

The baseline at `0373cc14b43741ba82630acf0d57f6d8a7c84a15` had 13 flat files,
201 executed cases, and a 938-line mixed control-plane suite. Its behavioral
coverage was valuable, but location, selection and boundary intent were not
discoverable from the tree.

| Checkpoint | Baseline assessment | Target state |
| --- | --- | --- |
| R0 — repository shape | All ARCP tests were peers in one directory. | Every deterministic test has one layer directory; support and canary code are explicit. |
| R1 — reusable setup | Several suite-local Paseo fakes repeated ordinary command behavior. | A narrow stateful fake and service creator serve compatible service tests; specialized fakes remain local. |
| R2 — selective execution | Only an all-files runtime command existed. | Each layer and the complete deterministic suite have a named command. |
| R3 — real-boundary honesty | Campaign-state cases silently passed without their external input. | They are required-input canaries outside the default suite; local child-process tests remain deterministic adapters. |
| A0 — discovery | A contributor had to inspect test bodies to choose a home. | The table above is the placement rule and command index. |
| A1 — preservation | Coverage could be lost during moves without a runner-visible inventory. | Compare `vitest list` and static `it(` totals before/after; explain any intentional count change. |
| A2 — behavior | Broad suite was run as one undifferentiated group. | Run the affected layer plus `test:deterministic`; report both exit codes. |
| A3 — construction | Test moves could leave broken imports or formatting. | Run the runtime build and `git diff --check` for the candidate. |
