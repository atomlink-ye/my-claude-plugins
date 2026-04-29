# Daytona Artifact Workflows

## Push local files or directories

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" push \
  --directory "$WORK_DIR" \
  --path "$LOCAL_PATH" \
  --remote-path "$REMOTE_PATH"
```

`push` currently uses bundle mode. Directory pushes extract the directory contents into the remote workspace rather than nesting the local directory basename.

## Pull artifacts

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" pull \
  --directory "$WORK_DIR" \
  --remote-path "$REMOTE_ARTIFACTS" \
  --output "$WORK_DIR/artifacts/daytona/$TASK_ID"
```

Artifact paths are project-local by default under `artifacts/daytona/<task-id>`.

## Safety rules

- Validate archive entries before extraction.
- Reject absolute paths, parent traversal, and unsafe task ids.
- Quote all local and remote paths.
- Keep generated artifacts outside source skill directories.
