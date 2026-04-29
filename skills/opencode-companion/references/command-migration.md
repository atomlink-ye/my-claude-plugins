# OpenCode Command Migration

Slash commands are no longer the primary API. Use `opencode-companion` plus direct script calls.

| Old term | Replacement |
|---|---|
| `/opencode:task` | `session new --directory "$WORK_DIR" -- "<prompt>"` |
| `/opencode:rescue` | `session continue "$SID" --directory "$WORK_DIR" -- "<rescue prompt>"` or `session attach` |
| `/opencode:review` | `review --scope ... --wait` |
| `/opencode:adversarial-review` | `review --adversarial --scope branch --base "$BASE_REF" --wait` |
| `/opencode:status` | `serve status`, `session status`, or `job status` depending on state type |
| `/opencode:wait` | `session wait` or `job wait` |
| `/opencode:result` | `job result` |
| `/opencode:cancel` | `job cancel` |
| `/opencode:serve` | `serve status|start|stop` |

When users say an old command name, answer with the replacement script invocation and mention that command wrappers were removed/replaced.

The old plugin directory and command wrappers are removed. Do not write new docs that depend on plugin-local paths.
