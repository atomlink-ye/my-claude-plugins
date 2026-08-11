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
such as heartbeat create/delete. This supersedes the earlier note that the daemon has
no `heartbeat ls`/`inspect` and that ids must be probed with `heartbeat update`.
The companion persists run ids and cursors because the daemon does not push run events;
`last_fired_at` is therefore taken only from a run's `startedAt`/`scheduledFor`, never
from a cron-derived next-run value. A missing schedule is rebuilt only for an explicit
not-found response (and an existing deterministic name is adopted first); transient
CLI failures remain unknown and are not rebuilt. Labels are treated as visual
best-effort signals and the local append-only ledger is the authority for
park/known-red/deferred decisions.

## Observed gaps (2026-08-10, agent-server platformization round)

Two behaviours of the missed-wakeup invariant (`reconcileOnce`) produced repeated
false alarms during a deliberate Owner-ordered stop.

**1. The invariant ignored the park ledger.** — ✅ **addressed 2026-08-11.**
Its condition was `children.every(idle-ish) && selfWakeupSources.length === 0`,
which never consulted `type: 'park'` records even though `listChildren` already
computed a per-child `parked` flag from exactly that ledger. Three children
explicitly parked with `verdict`, `reason` and `recovery` still tripped the alarm
every ~5 minutes. A parked child is a recorded decision, not a forgotten one.
Per-child watches now treat an unrevoked park record as the *only* exemption.

**2. `selfWakeupSources` only counts this service's own reminders.** — ⚠️ **still open.**
A manager whose live wakeup source is a harness-tracked background task (the normal
way to arm a `paseo wait` or a long build) reads as having none. The practical
workaround is to register a companion reminder that *represents* the external wakeup
source, which keeps the invariant honest rather than silencing it — but it means the
invariant measures "reminders registered here", not "wakeup sources that exist".
