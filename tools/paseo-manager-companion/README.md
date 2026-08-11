# Paseo Manager Companion

Small local HTTP service that keeps Manager-side Paseo reminders, child visibility,
compact recovery, briefings, and decision ledger in one place. It only invokes the
public `paseo` CLI; daemon state remains authoritative.

```sh
pnpm install
pnpm build
PASEO_AGENT_ID=<manager-id> PORT=8787 node dist/server.js
```

Routes:

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | — | uptime and reconciliation status |
| GET | `/heartbeats` | — | registered heartbeat observations (`id`, `cron`, `last_fired_at`, `last_delivered_at`, `missed_fires`, `next_run`, `alive`) |
| GET | `/children?agentId=` | — | `{children, selfWakeupSources, partial, failedCandidates}`; inspect failures are explicit |
| POST | `/spawn` | provider, model?, title, cwd, prompt, label? | spawned agent |
| POST | `/reminders` | agentId, delaySeconds, message, context? | durable at-least-once reminder |
| DELETE | `/reminders/:id` | `{reason}` | deletes daemon heartbeat and records acknowledgement |
| POST | `/messages` | `{to, from, body, urgency?: "normal"|"urgent"}` | durable, coalesced one-shot delivery |
| POST | `/compact-wake` | agentId, resumeSteps | recovery heartbeat (observation is bounded) |
| GET | `/children/:id/briefing` | `since` optional | git commits/status/diff stat |
| POST | `/ledger` | type, target, verdict, reason, recovery? | park/known-red/deferred record |
| GET | `/ledger` | type?, target? | active records |
| POST | `/ledger/:id/revoke` | `{reason}` | append-only resolution |

`POST /ledger` and `DELETE /reminders/:id` reject missing reasons (and ledger
verdicts) with HTTP 400. Reminder prompts contain a ready-to-paste acknowledgement
command and a 30-minute expiry. Messages intentionally contain no acknowledgement
text: they are persisted first, grouped by sender, timestamped, and delivered by
at most one `heartbeat create ... --max-runs 1` schedule per recipient. Urgent
messages are first at the queue head and attempted on the next scheduled turn
after the recipient is available; they are not an interrupt and do not displace a
currently running recipient. The one-minute cadence and reconciliation interval
are not an exact-turn SLA. A failed busy run
retains its batch and is re-armed; only the exact successful batch is removed.

Heartbeat observations are read from `schedule inspect` and `schedule logs`.
Run timestamps come only from actual `startedAt`/`scheduledFor` entries; run ids
and delivery counters are durable across restarts. Missing schedules are rebuilt
by deterministic name (with duplicate adoption via `schedule ls`) and recorded in
the decision ledger, while transient CLI failures remain unknown and are not rebuilt.

One-line worker usage:

```sh
curl -sS -X POST http://127.0.0.1:8787/messages -H 'content-type: application/json' -d '{"to":"worker-id","from":"manager-id","body":"Please review the diff","urgency":"normal"}'
```

Use `send` for a deliberate immediate follow-up when the worker can safely be
interrupted, `/reminders` for a repeated/time-based nudge that needs an explicit
acknowledgement, and `/messages` for durable asynchronous content that should be
coalesced and delivered at the next available turn. The old one-message-per-
heartbeat limitation no longer applies to `/messages`.

Children inspection is bounded to eight Paseo CLI processes at a time. An inspect is
retried once; if it still fails, the response sets `partial: true` and reports the
candidate id, error, and category in `failedCandidates` rather than silently dropping
it. Candidates with a different `ParentAgentId` are intentionally omitted and are not
reported as failures.

For a local smoke test against the real Paseo daemon, set `PASEO_AGENT_ID` and run
`scripts/smoke.sh`. The script accepts `PASEO_PROVIDER`, `PASEO_MODEL`, and
`PASEO_CWD` overrides.
