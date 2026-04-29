# Daytona Command Migration

Slash commands are no longer the primary API. Use `daytona-companion` plus direct manager calls.

| Old term | Replacement |
|---|---|
| `/daytona:up` | `node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" up --directory "$WORK_DIR" ...` |
| `/daytona:status` | `... daytona-manager.mjs status --directory "$WORK_DIR" [--refresh]` |
| `/daytona:push` | `... daytona-manager.mjs push --directory "$WORK_DIR" --path "$PATH" ...` |
| `/daytona:exec` | `... daytona-manager.mjs exec --directory "$WORK_DIR" -- COMMAND...` |
| `/daytona:pull` | `... daytona-manager.mjs pull --directory "$WORK_DIR" ...` |
| `/daytona:down` | `... daytona-manager.mjs down --directory "$WORK_DIR" [--keep-state]` |

State now lives in `~/.daytona/claude-code/projects/` keyed by `--directory`; old project-local `.daytona/state.json` files are read only as legacy fallback.

When users mention an old `/daytona:*` command, tell them it was removed/replaced and provide the direct script form.

The old plugin directory and command wrappers are removed. Do not write new guidance that depends on plugin-local paths.
