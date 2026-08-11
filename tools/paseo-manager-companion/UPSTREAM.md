# Upstream limitations

The public Paseo CLI does not expose a push/event subscription for a parent when a
child reaches an idle, error, or disconnected terminal state. This service therefore
uses global `paseo ls -g --json` plus `paseo inspect --json` for visibility and a
bounded reconciliation loop for the missed-wakeup invariant.

Parent filtering is an N+1 operation: `ls -g --json` does not include
`ParentAgentId`, so every candidate requires an `inspect --json` call. The service
limits this fan-out to eight concurrent CLI processes and returns explicit
`failedCandidates`/`partial` metadata when a retry still fails. A candidate with a
different parent is a normal non-match, not an error.

The daemon also has no `heartbeat ls`/`heartbeat inspect`; known heartbeat ids are
probed with `heartbeat update` using the original cron. Inspect does not return labels,
so labels are treated as visual best-effort signals and the local append-only ledger is
the authority for park/known-red/deferred decisions.

## Observed gaps (2026-08-10, agent-server platformization round)

Two behaviours of the missed-wakeup invariant (`reconcileOnce`, `service.ts:274`)
produced repeated false alarms during a deliberate Owner-ordered stop.

**1. The invariant ignores the park ledger.**
Its condition is `children.every(idle-ish) && selfWakeupSources.length === 0`.
It does not consult `type: 'park'` records, even though `listChildren` already
computes a per-child `parked` flag from exactly that ledger (`service.ts:83`).
Three children explicitly parked with `verdict`, `reason` and `recovery` still
tripped the alarm every ~5 minutes. A parked child is a recorded decision, not a
forgotten one — that distinction is the stated reason this service exists.
Suggested: skip children whose `parked` flag is true when evaluating the
"all children finished" half of the condition.

**2. `selfWakeupSources` only counts this service's own reminders.**
A manager whose live wakeup source is a harness-tracked background task (the
normal way to arm a `paseo wait` or a long build) reads as having none. The
practical workaround is to register a companion reminder that *represents* the
external wakeup source, which keeps the invariant honest rather than silencing
it — but it means the invariant measures "reminders registered here", not
"wakeup sources that exist".
