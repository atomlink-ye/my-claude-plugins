# Daytona Sandbox Lifecycle

Use the manager script from the marketplace root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" <command> [options]
```

## Create or reconnect

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" up \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --env-file "$WORK_DIR/.env.local"
```

## Inspect state

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" status --directory "$WORK_DIR"
```

`status` should use local state only unless `--refresh` is explicit.

State is read from the global project registry by default:

```text
~/.daytona/claude-code/projects/<project-directory-hash>.json
```

Use `--state-directory DIR` only for tests or explicit isolation.

## Execute remotely

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" exec \
  --directory "$WORK_DIR" \
  --cwd "/workspace/$TASK_ID" \
  -- pnpm test
```

Pass commands after `--` so arguments are quoted as literal remote command arguments.

## Delete

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" down --directory "$WORK_DIR"
```

Use `--keep-state` only when preserving local metadata is intentional.
