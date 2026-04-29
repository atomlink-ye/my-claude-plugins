# Daytona Companion Troubleshooting

## SDK unavailable

Install `@daytona/sdk` where the manager script can resolve it. `--help` and local-only `status` should not require network access.

## Status is stale

By default, `status` reads the global project-scoped state file under `~/.daytona/claude-code/projects/`. Use `--refresh` only when you intentionally want a Daytona SDK/network call.

## Secrets appear in output

Stop and treat this as a bug. Status output must redact secret values and summaries must not print `.env.local` contents.

## Remote command quoting

Pass remote commands after `--`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" exec --directory "$WORK_DIR" -- pnpm test
```

Do not interpolate raw user command strings into shell substitutions.

## State is in the wrong place

Move state under `~/.daytona/claude-code/projects/` or pass `--state-directory DIR` for explicit isolation. Never persist runtime state in the marketplace, plugin, skill source tree, or new project-local `.daytona/` files.
