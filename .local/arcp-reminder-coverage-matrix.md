# ARCP reminder retirement coverage — Phase A

| Legacy surface | ARCP CLI | Durable owner | Verification | Status |
|---|---|---|---|---|
| `/reminders` once/repeat/list/delete | `reminder add|list|delete` | Companion Store | paseo-reminder suite | covered |
| `/messages` notify/ack/reply, on-idle/interrupt | `message send|list|ack|reply` | Companion Store | transport suite | partial: reply uses legacy delete acknowledgement path |
| `/children`, `/children/:id`, `/watch` | `child list|watch|unwatch` | tracked-children Store | watchdog suite | covered |
| `/wakeup-sources`, `/heartbeats` | `wakeup add|list|delete`, `heartbeat list|delete` | wakeup/schedule Store | round7/heartbeat suite | covered |
| `/context-usage`, idle/context subscriptions | `context usage`, `idle add|list|delete`, `compact` | observer/idle Store | round9 suite | partial: context-percent subscription flags remain direct legacy payload |
| `/compact-wake` | `compact` | idle/reminder Store | context suite | covered |
| `/corrections`, `/gate` | `correction open|list|resolve`, `gate` | corrections Store | correction suite | covered |
| `/ledger` | `ledger add|list|revoke` | ledger Store | integration suite | covered |

Sources: `runtime/src/server.ts` ROUTES, `runtime/src/types.ts`, `eval/paseo-reminder/tests`, `skills/paseo-companion/SKILL.md`, and Personal Dev Guide raw-curl examples. Phase A is not retirement-ready while rows marked partial/missing remain.
