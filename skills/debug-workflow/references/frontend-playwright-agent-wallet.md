# Frontend debug with Playwright + agent-wallet

This is the primary lane for real browser-based reproduction.

## When to use this lane

Use this lane when the reported issue involves:
- page rendering
- route or navigation mismatch
- click-flow regression
- missing or incorrect UI state
- wallet connection state
- dApp approval flow
- anything that must be seen in a browser rather than inferred from code

## Preferred tool order

1. **Local dev app** if available
2. stable hosted environment if accessible
3. protected preview only when auth is already available

## Preferred browser strategy

Default to **Playwright / browser MCP** for deterministic reproduction.

Why:
- easier assertions
- easier screenshots
- better repeatability
- better future regression harnessing

## Wallet strategy

Only add agent-wallet when wallet state is required.

### Preferred mode

Use **shared Chrome / CDP** mode.

Pattern:
1. launch Chrome or Chromium with remote debugging
2. start `agent-wallet` in `--no-browser` mode
3. attach agent-wallet to the same CDP browser
4. drive the page with Playwright / browser MCP
5. let agent-wallet handle provider injection and approval queue

## Known-good agent-wallet facts

Validated on this machine:
- `no-browser-mode.test.ts` passes
- `cdp-attach.test.ts` passes

This is enough to trust the shared-CDP path for debugging work.

## Baseline workflow

### Step 1 — Verify the target environment

Check whether the supposed target is actually usable.

Examples of blockers:
- preview redirects to login
- staging is 404
- required data is absent
- route is not present in local build

Record blockers explicitly.

### Step 2 — Start the local app when possible

Typical example:
```bash
pnpm install
pnpm dev
```

Then confirm the port is open and the page loads before deeper debugging.

### Step 3 — Reproduce without wallet first

Use the browser to answer:
- does the route load?
- does the expected control exist?
- does the interaction fail visually?
- are console/network failures visible?

Capture:
- URL
- screenshot
- DOM state / control presence
- console or network errors if relevant

### Step 4 — Escalate to wallet-aware reproduction only if needed

If the bug depends on wallet connect/sign/chain state:

#### Example sequence
1. start shared Chrome
2. start agent-wallet daemon-only
3. `attach_to_cdp`
4. `set_chain`
5. `set_private_key` or equivalent seeded wallet
6. drive connect flow in browser
7. `wait_for_request`
8. `approve_request`

## Reproduction verdicts

Use one of:
- `reproduced`
- `not_reproduced`
- `blocked`
- `needs_more_context`

### Good `blocked` examples
- preview requires Vercel auth
- upstream API route returns 404
- local route missing entirely
- wallet path requires credentials or chain data not available

## Evidence checklist

For each issue, try to capture at least 2 of:
- local URL
- screenshot
- DOM/control presence
- console error
- network failure
- code location likely related
- environment blocker explanation

## Strong rule

Do not say a walkthrough item is reproduced just because a related page opens.
The reported business symptom itself must be observed, or the verdict should be `not_reproduced` / `blocked`.
