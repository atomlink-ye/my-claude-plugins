# Manager 安全网：paseo-manager-companion

When you (the Manager) are orchestrating multiple child agents through Paseo and
need to stop losing track of them — a spawned lane that nobody is waiting on, a
reminder that quietly expired, a park with no reason attached — start
`tools/paseo-manager-companion` and drive it through its HTTP API instead of
hand-rolling shell watchdogs. It exists because a hand-rolled watchdog +
TSV ledger already failed once in production (see PROPOSAL.md in
`tasks/active/paseo-companion-manager-skill-20260808/` for the failure evidence).

**Design rule it enforces**: the Paseo daemon is the source of truth for time and
agent state (`paseo heartbeat`, `paseo inspect`, `paseo ls -g`). The service adds
no parallel state that can drift *except* the one thing the daemon genuinely has
no home for — the park / known-red / deferred decision ledger.

## Start it

```bash
cd tools/paseo-manager-companion
pnpm install && pnpm build
PASEO_AGENT_ID=<your-own-agent-id> PORT=8787 node dist/server.js
```

`PASEO_AGENT_ID` must be your own agent id (`echo $PASEO_AGENT_ID` inside a Paseo
agent shell) — reminders and heartbeats target "this agent" through that env var.

## Routes

| Route | Use it for |
|---|---|
| `GET /children?agentId=<self>` | "What are my tracked child agents doing, and does each one still have a live wakeup source?" Discovery auto-enrolls only parseable post-start children; unparseable/old children stay untracked. |
| `POST /spawn` | Fast-path wrapper over `paseo run -d`. Not required for correctness — the reconciliation loop (below) catches children spawned by raw `paseo run` too. |
| `POST /reminders` `{agentId, delaySeconds, message, context?}` | `remind_me_in(seconds, message)`. At-least-once — the current reminder repeats until acknowledged with `DELETE`, capped by a TTL (default 30-60min). Acknowledging an automatic child-watch delivery does not unsubscribe that child; reconciliation arms its next watch. |
| `POST /messages` `{to, from, body, urgency?}` | Durable asynchronous queue. Pending records are grouped and handed to `paseo send --no-wait`; acceptance marks ordinary records `delivered` (retained until per-ID acknowledgement). Recovery records are ephemeral after receipt application. |
| `GET /messages?to=<agent-id>` | Observe durable pending/delivered records (optionally filtered by recipient) before acknowledging them. |
| `DELETE /messages/:id` `{reason}` | Acknowledge/remove one pending or delivered record. Repeating a prior acknowledgement is idempotent; unknown IDs are 404. |
| `PUT /children/:childId?agentId=` | Explicitly track a manager/child pair, clear opt-out, and ensure its watch. The `/watch` alias remains compatible. |
| `DELETE /children/:childId?agentId=` `{reason}` | Persistently opt out and retire tracking/watch/recovery. The `/watch` alias remains compatible. |
| `DELETE /reminders/:id` `{reason}` | Acknowledge this delivered reminder only. It clears that reminder's missed-fire state and has no subscription-policy side effect. `reason` is required — 400 without it. |
| `DELETE /children/:childId/watch?agentId=` `{reason}` | Persistently stop automatic watch registration for one manager/child pair; all existing copies are retired. |
| `PUT /children/:childId/watch?agentId=` `{reason?}` | Explicitly restore automatic watch registration for the pair. |
| `DELETE /heartbeats/:id` `{reason}` | Delete a listed heartbeat id (or an unambiguous 8+ character prefix). Deleting a child-watch heartbeat is an explicit persistent pair unsubscribe; prefer the child-watch route above when the child identity is known. |
| `POST /compact-wake` `{agentId, resumeSteps}` | Call right before self-compact. Arms a fallback heartbeat immediately, then watches for you to go idle and *stay* idle for a debounce window before delivering `resumeSteps` — not a blind fixed delay. |
| `GET /children/:id/briefing` | The "what happened while I was waiting" report §2 of PROPOSAL.md asks for: commits, uncommitted changes, diff stat. Reads git directly (not `paseo logs` — see UPSTREAM.md #6). |
| `POST /ledger` `{type, target, verdict, reason, recovery?}` | park / known-red / deferred, unified. Missing `verdict` or `reason` → 400, always, no exceptions. |
| `GET /ledger`, `POST /ledger/:id/revoke` | Query and unwind decisions (append-only — revocation doesn't erase history). |
| `GET /health` | For your own bootstrap check; also referenced inside every reminder prompt so a dead service is discoverable through the same channel that delivers the reminder. |

Reminders are recurring cron prompts through the daemon's system/schedule wrapper.
Repetition, TTL, and max-runs are explicit schedule behavior; a busy recipient may
miss a fire, which is counted for recovery instead of assumed processed.

Worker message example (acknowledge each returned ID separately):

```sh
curl -sS -X POST http://127.0.0.1:8787/messages -H 'content-type: application/json' -d '{"to":"worker-id","from":"manager-id","body":"Please review the diff","urgency":"normal"}'
```

Track or opt out a child explicitly:

```sh
curl -X PUT 'http://127.0.0.1:8787/children/child-id?agentId=manager-id'
curl -X DELETE 'http://127.0.0.1:8787/children/child-id?agentId=manager-id' -H 'content-type: application/json' -d '{"reason":"closed lane"}'
```

Decision guide: use `paseo send` for a deliberate follow-up when interruption is
safe; `/reminders` for a repeated/time-based nudge needing explicit acknowledgement;
`/messages` for durable asynchronous worker content that should be coalesced without
interrupting a running worker.

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
- **Reminder delivery precision is minute-granularity**, not exact-second. Cron
  underneath has no sub-minute resolution.
- Service-local records (which heartbeat id maps to which reminder) can drift from
  daemon truth if the service's storage is lost between restarts; it self-heals via
  a `heartbeat update <id> --cron <unchanged>` probe at startup, but a total data
  loss produces harmless orphan heartbeats (extra noise), not silent failure.

For messages, the authoritative handoff is the `paseo send --no-wait` response. In
the installed CLI this still awaits `sendAgentMessage`; `--no-wait` only skips
`waitForFinish`, so acceptance is daemon receipt rather than recipient processing.
Missing, false, or failed status leaves the batch pending for 15-second retry.
Urgent means queue-head priority inside a coalesced batch, not immediate interruption
or an exact-turn SLA.

## Full spec

`tasks/active/paseo-companion-manager-skill-20260808/DISPATCH-CODEX-SERVICE.md` has
the complete design rationale, the verified CLI facts it's built on, and the
reasoning behind each cut/keep decision (an earlier 11-route draft was trimmed to 8
after independent review — don't re-add `GET /wakeup-source` or separate
`POST /park`/`POST /unpark` endpoints; they were folded into `/children` and
`/ledger` on purpose).
