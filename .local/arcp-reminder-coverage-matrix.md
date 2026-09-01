# ARCP reminder retirement coverage — Phase A

| Legacy surface / behavior | ARCP owner and CLI | Durable projection | Verification | Status |
|---|---|---|---|---|
| `/reminders` once/repeat/targetAt/maxRuns/delivery | `reminder add|list|get|delete` | Companion reminder audit; ARCP delivery for bound Runtime | runtime suite + seam regression | covered |
| Child-watch/watchdog/heartbeat-recovery reminders | same reminder commands | Legacy reminder identity retained; no Companion heartbeat for bound Runtime | round6 + ARCP seam | covered |
| `/messages` notify/ack/reply, filters and delivery modes | `message send|list|ack|reply` | Companion message audit plus `transportOwner=arcp`, stable ARCP source delivery ID | round8 + seam regression | covered |
| `/messages` sender authentication | actor/member/admin credential; `from` remains audit-only | ARCP session owner is internal delivery actor | migration-auth and injection regression | covered |
| `/idle-reminders` idle/context-percent trigger and compact subscription | `idle add|list|delete`, `compact` | idle store; ARCP delivery for bound Runtime | round6/round9 + payload regression | covered |
| `/compact-wake` direct compact + wake | `compact` | idle/reminder store and ARCP delivery seam | round6 + runtime suite | covered |
| `/children`, `/watch`, watchdog and lifecycle recovery | `child list|watch|unwatch|briefing` | tracked-children/watchdog stores | round6/round7/round9 | covered |
| `/wakeup-sources`, `/heartbeats` filters | `wakeup add|list|delete`, `heartbeat list|delete` | wakeup/schedule store | heartbeat/round7 | covered |
| `/context-usage` | `context usage` | context observer/store | round9 + CLI payload regression | covered |
| `/corrections`, `/gate` | `correction open|list|resolve`, `gate` | corrections store | correction suite | covered |
| `/ledger` | `ledger add|list|revoke` | ledger store | integration suite | covered |
| Read-only control overview | `tui`, `tui --snapshot` | no state mutation | deterministic snapshot regression | covered |

Phase B remains mechanical only: delete the old package/re-export paths, move remaining evaluation naming, and clean legacy reference/docs after independent `RETIRE_ACCEPT`. No Phase A behavior row is partial.
