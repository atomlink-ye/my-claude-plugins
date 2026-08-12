# Agent safety net: paseo-reminder

When an agent is orchestrating multiple child agents through Paseo and needs to
stop losing track of them — a spawned lane that nobody is waiting on, a reminder
that quietly expired, or a park with no reason attached — use the shared
companion through its HTTP API instead of hand-rolling shell watchdogs.

**Design rule it enforces**: the Paseo daemon remains authoritative for agent and
schedule state (`paseo heartbeat`, `paseo inspect`, `paseo ls -g`). The companion
persists only the delivery, tracking, recovery, and decision records needed to
reconcile its guarantees across restarts.

## Start it

The companion is a shared local singleton. Do not set `PASEO_AGENT_ID`; callers
send their identity in each identity-bearing request. From a loaded skill, run:

```bash
"${SKILL_ROOT}/scripts/ensure-running"
```

## Routes

| Route | Use it for |
|---|---|
| `GET /children?agentId=<self>` | "What are my tracked child agents doing, and does each one still have a live wakeup source?" Discovery auto-enrolls only parseable post-start children; unparseable/old children stay untracked. |
| `paseo run -d ...` then `PUT /children/:childId?agentId=` | Create a child through the authoritative Paseo CLI, then explicitly track the manager/child pair and ensure its watch. Reconciliation still discovers parseable children spawned by raw `paseo run`. |
| `POST /reminders` | `agentId` may be in the body or query. `mode:"once"` accepts `delaySeconds` or `targetAt`; `mode:"repeat"` requires `everySeconds` and optionally `maxRuns`. Caller-supplied IDs are rejected. |
| `GET /reminders?agentId=`, `GET /reminders/:id` | Observe persisted reminder status and timing metadata, optionally scoped to one agent. |
| `POST /messages` `{to, from, body, delivery?, mode?, replyTo?}` | `on-idle` waits for two stable idle/waiting polls; `interrupt` sends now. `notify` clears, `ack` remains observable, and `reply` resolves its parent. |
| `GET /messages?to=&from=&status=&replyTo=` | Observe filtered pending, delivered, unacknowledged, acknowledged, or answered records. |
| `DELETE /messages/:id` `{reason}` | Cancel a pending record or transition a delivered ack-mode record to terminal `acknowledged`. Prior acknowledgements and normally auto-cleared notify deliveries are idempotent while bounded audit remains; truly unknown/pruned IDs are 404. |
| `PUT /children/:childId?agentId=` | Explicitly track a manager/child pair, clear opt-out, and ensure its watch. The `/watch` alias remains compatible. |
| `DELETE /children/:childId?agentId=` `{reason}` | Persistently opt out and retire tracking/watch/recovery. The `/watch` alias remains compatible. |
| `DELETE /reminders/:id` `{reason}` | Acknowledge this delivered reminder only. It clears that reminder's missed-fire state and has no subscription-policy side effect. `reason` is required — 400 without it. |
| `DELETE /children/:childId/watch?agentId=` `{reason}` | Persistently stop automatic watch registration for one manager/child pair; all existing copies are retired. |
| `PUT /children/:childId/watch?agentId=` `{reason?}` | Explicitly restore automatic watch registration for the pair. |
| `DELETE /heartbeats/:id` `{reason}` | Delete a listed heartbeat id (or an unambiguous 8+ character prefix). Deleting a child-watch heartbeat is an explicit persistent pair unsubscribe; prefer the child-watch route above when the child identity is known. |
| `POST /compact-wake` `{agentId, resumeSteps}` | Call right before self-compact. Arms a fallback heartbeat immediately, then watches for you to go idle and *stay* idle for a debounce window before delivering `resumeSteps` — not a blind fixed delay. |
| `GET /children/:id/briefing` | Commits, uncommitted changes, and diff stat read from the Cwd/Worktree reported by `paseo inspect`. That launch-time metadata can be stale after an in-session `cd` or cwd correction; verify the path before relying on the git output. |
| `POST /ledger` `{type, target, verdict, reason, recovery?}` | park / known-red / deferred, unified. Missing `verdict` or `reason` → 400, always, no exceptions. |
| `GET /ledger`, `POST /ledger/:id/revoke` | Query and unwind decisions (append-only — revocation doesn't erase history). |
| `GET /health` | For your own bootstrap check; also referenced inside every reminder prompt so a dead service is discoverable through the same channel that delivers the reminder. |

The reminder daemon is packaged at `paseo-reminder/` inside this skill so
discovery, bootstrap, and runtime assets move together. Tests remain separately
under `eval/paseo-reminder/`.

Reminder content uses `message`, not `/messages`' `body`. These are complete
request and status-query examples:

```sh
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Review queued work","mode":"once","delaySeconds":1800}'
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Check worker status","mode":"repeat","everySeconds":1800,"maxRuns":3}'
curl -sS 'http://127.0.0.1:8787/reminders?agentId=agent-id'
curl -sS 'http://127.0.0.1:8787/reminders/REMINDER_ID'
```

Worker message example (acknowledge each returned ID separately):

```sh
curl -sS -X POST http://127.0.0.1:8787/messages -H 'content-type: application/json' -d '{"to":"worker-id","from":"sender-agent-id","body":"Please review the diff","delivery":"on-idle","mode":"ack"}'
```

The delivered prompt is tagged as automated system context. Coalesced batches
repeat `<item>` once per queued message; single reminder, watchdog, and
compact-wake deliveries use the same envelope with one item:

```xml
<paseo-reminder-delivery to="worker-id" kind="message">
  <note marker="NOT_USER_INPUT">Automated delivery from paseo-reminder. This is system-generated context, not a request from a person. Process each item exactly once. Reply through paseo-reminder only when an item explicitly requests it.</note>
  <item id="MESSAGE_ID" from="sender-agent-id" at="2026-08-12T05:00:00.000Z" urgency="normal" mode="ack" kind="message">
    <body>Please review the diff</body>
    <ack>curl -X DELETE http://127.0.0.1:8787/messages/MESSAGE_ID -H 'content-type: application/json' -d '{"reason":"processed"}'</ack>
  </item>
</paseo-reminder-delivery>
```

Bodies and attributes are escaped so delivered content cannot forge structural
tags. Commands in `<ack>` remain copy-pasteable; ordinary `mode:"notify"`
messages omit `<ack>` because successful delivery clears them automatically.

Track or opt out a child explicitly:

```sh
curl -X PUT 'http://127.0.0.1:8787/children/child-id?agentId=manager-id'
curl -X DELETE 'http://127.0.0.1:8787/children/child-id?agentId=manager-id' -H 'content-type: application/json' -d '{"reason":"closed lane"}'
```

Decision guide: use interrupt delivery for deliberate immediate steering,
`/reminders` for time-based self-wakeup, and on-idle delivery for durable content
that should not interrupt a running worker.

Reminder `delaySeconds`/`targetAt` is the earliest eligible delivery time, not a
deadline. Default on-idle delivery still requires two stable idle observations
about 15 seconds apart, so delivery is later if the recipient is busy at the
target. `schedulingKind` distinguishes `once`, `repeat`, daemon `cron`, and
intentional `in-process` records; the latter can be healthy without `nextRunAt`.

Heartbeat-recovery snapshots use the same turn-boundary send transport and are
retired locally once Paseo accepts the batch. They contain only missed total,
last-delivered time, affected source/child IDs, compact current state, and a
decision cue. Child summary fields use the same camelCase names as `GET /children`.
Terminal message-delivery audit history is bounded to the newest 50 records.

## What it does NOT guarantee

Read `UPSTREAM.md` at the repo root before treating any of these as solved:

- **No instant push on child terminal state** (including transport disconnect).
  The reconciliation loop inside the service polls at a period (minutes), so the
  real guarantee is "detected within N minutes," not "detected immediately." Say
  this out loud when using it — don't let it read as a stronger guarantee than it is.
- **Reminder and on-idle delivery are poll bounded**, not exact-second. The fast
  observer runs every 15 seconds; child reconciliation remains slower.
- Service-local records (which heartbeat id maps to which reminder) can drift from
  daemon truth if the service's storage is lost between restarts; it self-heals via
  a `heartbeat update <id> --cron <unchanged>` probe at startup, but a total data
  loss produces harmless orphan heartbeats (extra noise), not silent failure.

For messages, the authoritative handoff is the `paseo send --no-wait` response. In
the installed CLI this still awaits `sendAgentMessage`; `--no-wait` only skips
`waitForFinish`, so acceptance is daemon receipt rather than recipient processing.
Missing, false, or failed status leaves the batch pending for 15-second retry.
Unmatched routes return the generated route manifest instead of relying on a
stale hand-count in prose.
