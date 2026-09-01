# Claude interrupt and cache guard dogfood (redacted)

Date: 2026-09-01. An isolated ARCP server and temporary 0600 client state launched one disposable Claude `auto` runtime.

- Normal `arcp send` while the original turn was running remained `waiting_safe_point`; it did not become an interrupt.
- The first `arcp interrupt` returned a hold receipt with a short-lived opaque token and created no interrupt delivery. The runtime remained running when inspected.
- Confirming that fresh receipt sent exactly one explicit interrupt delivery. A later receipt was made stale by a normal safe-point turn; confirmation returned `Claude interrupt confirmation is stale; no interrupt was sent`.
- Panorama used provider activity `lastUserMessageAt`, not ARCP observation time, and showed fresh activity, healthy status, zero pending permissions, and no compaction.
- Shipped defaults are asserted in focused tests as 55/60 minutes. A separate isolated server deliberately set both cache thresholds to zero solely for dogfood: normal send held with `cache is expired`, offered exact fresh-session handoff and `arcp reuse --confirm` commands, and confirmed reuse delivered a new normal turn.

No keepalive or compaction was sent. Provider handles, credentials, paths, prompts, and token values are omitted. The Claude agent was archived; isolated server and temporary state were removed afterward.
