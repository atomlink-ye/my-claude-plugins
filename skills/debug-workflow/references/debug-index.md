# Debug index

This skill is intentionally index-first.

## Current lanes

### Lane A — Frontend / browser / wallet
Use `references/frontend-playwright-agent-wallet.md` when the issue involves:
- route mismatch
- rendering / layout / interaction bugs
- QA walkthrough reproduction
- wallet connect / approve / chain switch
- `window.ethereum` presence

## Planned lanes

Add these later as the workflow grows:
- `backend-api-dependency-debug.md`
- `data-pipeline-debug.md`
- `auth-and-permission-debug.md`
- `deployment-drift-debug.md`

## Design rule

Do not bloat `SKILL.md` with every command for every stack.
Keep the top-level skill as:
- routing layer
- shared truth model
- verdict taxonomy
- report contract

Put stack-specific procedures into reference files.
