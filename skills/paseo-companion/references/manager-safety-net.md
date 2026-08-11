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
| `GET /children?agentId=<self>` | "What are my child agents doing, and does each one still have a live wakeup source?" Ground-truth enumeration via `ParentAgentId`, not dependent on having spawned through this service. |
| `POST /spawn` | Fast-path wrapper over `paseo run -d`. Not required for correctness — the reconciliation loop (below) catches children spawned by raw `paseo run` too. |
| `POST /reminders` `{agentId, delaySeconds, message, context?}` | `remind_me_in(seconds, message)`. At-least-once — repeats until you `DELETE` it, capped by a TTL (default 30-60min). The daemon delivers it even while you're busy or disconnected. |
| `POST /messages` `{to, from, body, urgency?}` | Durable asynchronous message queue. Messages are grouped by sender into one one-shot schedule per recipient (`--max-runs 1`), with urgent messages at the queue head. Delivery is attempted on the next scheduled turn after availability is observed; it never interrupts a running recipient. |
| `DELETE /reminders/:id` `{reason}` | The explicit "I've decided not to wait anymore" action. `reason` is required — 400 without it. |
| `POST /compact-wake` `{agentId, resumeSteps}` | Call right before self-compact. Arms a fallback heartbeat immediately, then watches for you to go idle and *stay* idle for a debounce window before delivering `resumeSteps` — not a blind fixed delay. |
| `GET /children/:id/briefing` | The "what happened while I was waiting" report §2 of PROPOSAL.md asks for: commits, uncommitted changes, diff stat. Reads git directly (not `paseo logs` — see UPSTREAM.md #6). |
| `POST /ledger` `{type, target, verdict, reason, recovery?}` | park / known-red / deferred, unified. Missing `verdict` or `reason` → 400, always, no exceptions. |
| `GET /ledger`, `POST /ledger/:id/revoke` | Query and unwind decisions (append-only — revocation doesn't erase history). |
| `GET /health` | For your own bootstrap check; also referenced inside every reminder prompt so a dead service is discoverable through the same channel that delivers the reminder. |

Worker message example:

```sh
curl -sS -X POST http://127.0.0.1:8787/messages -H 'content-type: application/json' -d '{"to":"worker-id","from":"manager-id","body":"Please review the diff","urgency":"normal"}'
```

Decision guide: use `paseo send` for a deliberate follow-up when interruption is
safe; `/reminders` for a repeated/time-based nudge needing explicit acknowledgement;
`/messages` for durable asynchronous worker content that should be coalesced without
interrupting a running worker.

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

For messages, schedule existence and run outcome are checked with `schedule inspect`
and `schedule logs`; the service does not use heartbeat update as a delivery probe.
If a schedule fires while its recipient is busy, the failed batch remains durable
and one replacement schedule is armed for the next scheduled attempt. Urgent means
queue-head priority, not immediate interruption or an exact-turn SLA; the one-minute
schedule cadence and reconciliation interval bound responsiveness.

## Full spec

`tasks/active/paseo-companion-manager-skill-20260808/DISPATCH-CODEX-SERVICE.md` has
the complete design rationale, the verified CLI facts it's built on, and the
reasoning behind each cut/keep decision (an earlier 11-route draft was trimmed to 8
after independent review — don't re-add `GET /wakeup-source` or separate
`POST /park`/`POST /unpark` endpoints; they were folded into `/children` and
`/ledger` on purpose).
