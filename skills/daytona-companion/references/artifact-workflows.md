# Daytona Artifact Workflows

## Push local files or directories

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" push \
  --directory "$WORK_DIR" \
  --path "$LOCAL_PATH" \
  --remote-path "$REMOTE_PATH"
```

`push` defaults to bundle mode. Directory pushes extract the directory contents into the remote workspace rather than nesting the local directory basename.

## Pull artifacts

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" pull \
  --directory "$WORK_DIR" \
  --remote-path "$REMOTE_ARTIFACTS" \
  --output "$WORK_DIR/artifacts/daytona/$TASK_ID"
```

Artifact paths are project-local by default under `artifacts/daytona/<task-id>`.

## Git sync mode

For repositories with committed history, use git mode to mirror local `HEAD` into the sandbox and fetch remote changes back into an isolated local branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" push \
  --directory "$WORK_DIR" \
  --path "$WORK_DIR" \
  --mode git \
  --branch "daytona/$TASK_ID"

node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" pull \
  --directory "$WORK_DIR" \
  --mode git \
  --branch "daytona/$TASK_ID"
```

Git mode transfers committed Git history using Git bundles. It intentionally does not include uncommitted local files; commit local changes before `push --mode git`. Remote changes are committed in the sandbox and fetched into the named local branch. The manager refuses to overwrite the currently checked-out local branch.

## Safety rules

- Validate archive entries before extraction.
- Reject absolute paths, parent traversal, and unsafe task ids.
- Quote all local and remote paths.
- Keep generated artifacts outside source skill directories.
- Prefer bundle mode for arbitrary artifacts and git mode for source history sync.
