# Paseo Reminder

Small local HTTP service that keeps shared agent Paseo reminders, child visibility,
compact recovery, briefings, and decision ledger in one place. It only invokes the
public `paseo` CLI; daemon state remains authoritative.

```sh
pnpm install
pnpm build
PORT=8787 node dist/server.js
```

The companion is a shared local singleton: callers provide their agent identity
on each identity-bearing request. The smoke script uses `PASEO_MANAGER_ID` only
to identify the manager for those requests.
Skill users should start or reuse it with
`skills/paseo-companion/scripts/ensure-running`; that launcher keeps state, logs,
and pid files outside this source tree by default.

Routes:

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | — | uptime and reconciliation status |
| GET | `/heartbeats` | `includeDead=1` optional | live heartbeat observations; terminal history is opt-in |
| DELETE | `/heartbeats/:id` | `{reason}` | deletes by exact id or an unambiguous 8+ character prefix; child watches become a durable unsubscribe |
| GET | `/children?agentId=` | — | `{children, selfWakeupSources, partial, failedCandidates}`; inspect failures are explicit |
| DELETE | `/children/:childId/watch?agentId=` | `{reason}` | durably disables that manager/child watch pair and retires all copies |
| PUT | `/children/:childId/watch?agentId=` | `{reason?}` | clears the durable opt-out and restores the default watch behaviour |
| POST | `/reminders` | `agentId` in body or query; once: `delaySeconds`/`targetAt`; repeat: `everySeconds` | earliest-target one-shot or explicit-interval reminder; caller-supplied `id` is rejected |
| GET | `/reminders?agentId=` | optional agent filter | persisted reminder state, including `status`, `nextRunAt`, and `lastFiredAt` |
| GET | `/reminders/:id` | — | one persisted reminder record |
| DELETE | `/reminders/:id` | `{reason}` | deletes daemon heartbeat and records acknowledgement |
| POST | `/messages` | `{to, from, body, delivery?, mode?, replyTo?, ackDeadlineSeconds?}` | durable interrupt or idle-heartbeat delivery |
| GET | `/messages` | `to?`, `from?`, `status?`, `replyTo?` | filtered message state |
| DELETE | `/messages/:id` | `{reason}` | cancel or acknowledge an ack-mode message |
| POST | `/compact-wake` | agentId, resumeSteps | recovery heartbeat (observation is bounded) |
| GET | `/children/:id/briefing` | `since` optional | git commits/status/diff stat |
| POST | `/ledger` | type, target, verdict, reason, recovery? | park/known-red/deferred record |
| GET | `/ledger` | type?, target? | active records |
| POST | `/ledger/:id/revoke` | `{reason}` | append-only resolution |

`POST /ledger` and `DELETE /reminders/:id` reject missing reasons (and ledger
verdicts) with HTTP 400. Messages are persisted first. Default
`delivery:"on-idle"` arms a repeating one-minute heartbeat for the coalesced
batch. Busy ticks are silently skipped and the next tick retries; after an actual
run, reconciliation records `deliveredAt` and retires the heartbeat.
`delivery:"interrupt"` uses `paseo send --no-wait` immediately. Default
`mode:"notify"` clears after accepted delivery; `ack` remains visible until
DELETE, then becomes `acknowledged` (bounded terminal history), and can become
`unacknowledged`; `reply` requires `replyTo` and marks the parent `answered`.
The deprecated `urgency` alias remains compatible.

`DELETE /messages/:id` is idempotent for acknowledged records and for normally
auto-cleared notify deliveries while their bounded delivery audit remains (the
newest 50 terminal schedules). A truly unknown or pruned ID returns 404.

Delivery safety decisions are explicit and tested: A6 bounds an on-idle delivery
to one safe-point attempt per durable delivery (busy or uncertain observations
leave it pending for a later reconciliation); A7 rejects withdrawal after a
delivery is accepted or processed, while allowing a still-waiting delivery to
be withdrawn. This prevents a late cancellation from claiming that an already
sent prompt was undone.

One-shot reminders store an absolute target and fire once. Repeating reminders
require an explicit `everySeconds`, plus optional `maxRuns`; `delaySeconds` is no
longer rounded into a recurring cron. `delaySeconds` and `targetAt` are the
earliest eligible delivery time, not a deadline: default on-idle delivery waits
for an idle heartbeat tick and can arrive later while the recipient remains busy.
Responses expose `schedulingKind`
(`once`, `repeat`, `cron`, or `in-process`), making an intentional in-process
record without `nextRunAt` distinguishable from a dead schedule.

The content field is `message` (not `body`). Copy-paste examples:

```sh
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Review queued work","mode":"once","delaySeconds":1800}'
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Check worker status","mode":"repeat","everySeconds":1800,"maxRuns":3}'
curl -sS 'http://127.0.0.1:8787/reminders?agentId=agent-id'
curl -sS 'http://127.0.0.1:8787/reminders/REMINDER_ID'
```

Child-watch cancellation is persisted in `child-watch-opt-outs.json` by manager
and child id, so reconciliation never recreates it after a restart. A malformed
opt-out file fails closed. Cancellation clears missed child-watch recovery state;
explicit `/messages` between any agents are never removed. Use the PUT watch route
to opt back in.

Heartbeat observations are read from `schedule inspect` and `schedule logs`.
Run timestamps come only from actual `startedAt`/`scheduledFor` entries; run ids
and delivery counters are durable across restarts. Missing schedules are rebuilt
by deterministic name (with duplicate adoption via `schedule ls`) and recorded in
the decision ledger, while transient CLI failures remain unknown and are not rebuilt.

One-line worker usage:

```sh
arcp message send worker-id sender-agent-id --body 'Please review the diff' --delivery on-idle --mode ack
```

Use interrupt delivery for a deliberate immediate follow-up, `/reminders` for
time-based self-wakeup, and on-idle delivery for durable asynchronous content.
Interrupt content appears as a complete turn in `paseo logs`. On-idle heartbeat
content does not appear there; confirm it only through `GET /messages` (for
observable ack/reply records) or `GET /reminders/:id` delivery metadata.

Every prompt emitted by the service is visibly system-generated and uses the
same escaped tagged envelope. Coalesced deliveries contain one `<item>` per
queued message; reminder, watchdog, and compact-wake deliveries contain one:

```xml
<paseo-reminder-delivery to="agent-id" kind="message">
  <note marker="NOT_USER_INPUT">Automated delivery from paseo-reminder. This is system-generated context, not a request from a person. Process each item exactly once. Reply through paseo-reminder only when an item explicitly requests it.</note>
  <item id="MESSAGE_ID" from="sender-agent-id" at="2026-08-12T05:00:00.000Z" urgency="normal" mode="ack" kind="message">
    <body>Please review the diff</body>
    <ack>arcp message ack MESSAGE_ID --reason processed</ack>
  </item>
</paseo-reminder-delivery>
```

Tag attributes and bodies are escaped so caller content cannot impersonate the
delivery structure. The command inside `<ack>` remains copy-pasteable. Ordinary
`mode:"notify"` messages have no `<ack>` because successful delivery clears them
automatically.

Children inspection is bounded to eight Paseo CLI processes at a time. An inspect is
retried once; if it still fails, the response sets `partial: true` and reports the
candidate id, error, and category in `failedCandidates` rather than silently dropping
it. Candidates with a different `ParentAgentId` are intentionally omitted and are not
reported as failures.

Briefings resolve git paths from the agent's `paseo inspect` Cwd/Worktree metadata.
That metadata is launch-time state and may be stale after an in-session `cd` or a
working-directory correction, so verify the path before relying on briefing git
output.

For a local smoke test against the real Paseo daemon, run `scripts/smoke.sh`.
The script accepts `PASEO_PROVIDER`, `PASEO_MODEL`, and
`PASEO_CWD` overrides.

Create children with the authoritative Paseo CLI, then explicitly register the
manager/child relationship with the companion:

```sh
child_json="$(paseo run -d --provider codex --title worker --cwd "$PWD" --json 'work')"
child_id="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.id||j.agentId)' "$child_json")"
curl -X PUT "http://127.0.0.1:8787/children/$child_id?agentId=manager-id"
```
