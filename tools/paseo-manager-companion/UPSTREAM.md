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
