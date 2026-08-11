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

Heartbeat registrations are observed through the Paseo daemon's direct schedule RPC
(`DaemonClient.scheduleList/Inspect/Logs`); the CLI remains reserved for mutations
such as heartbeat create/delete.
The companion persists run ids and cursors because the daemon does not push run events;
`last_fired_at` is therefore taken only from a run's `startedAt`/`scheduledFor`, never
from a cron-derived next-run value. A missing schedule is rebuilt only for an explicit
not-found response (and an existing deterministic name is adopted first); transient
CLI failures remain unknown and are not rebuilt. Labels are treated as visual
best-effort signals and the local append-only ledger is the authority for
park/known-red/deferred decisions.
