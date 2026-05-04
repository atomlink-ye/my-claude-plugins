---
name: daytona-companion
description: "Daytona sandbox companion. Load for sandbox up/status/push/exec/pull/down/preview/smoke-test requests, adopting existing sandboxes, artifact and git-sync workflows, and sandbox environment variables or secrets."
user-invocable: true
---

# Daytona Companion

Daytona provides remote cloud sandboxes for running code, tests, and services in isolation. This skill manages the full sandbox lifecycle — create, push code, execute, pull results, preview, and tear down.

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/skills/daytona-companion/scripts/daytona-manager.mjs"
else
  SCRIPT="$HOME/.agents/skills/daytona-companion/scripts/daytona-manager.mjs"
fi
```

## Typical workflows

### Create a sandbox, push code, run tests, pull results

The most common end-to-end flow:

```bash
# 1. Create (or reconnect to) a sandbox
node "$SCRIPT" up --directory "$WORK_DIR" --task-id "$TASK_ID" --class small

# 2. Push local code to the sandbox. Relative remote paths resolve under the sandbox user's $HOME.
node "$SCRIPT" push --directory "$WORK_DIR" --path "$WORK_DIR" --remote-path "workspace/$TASK_ID"

# 3. Execute tests remotely
node "$SCRIPT" exec --directory "$WORK_DIR" --cwd "workspace/$TASK_ID" -- pnpm test

# 4. Pull stdout/stderr/exit-code artifacts back
node "$SCRIPT" pull --directory "$WORK_DIR" --output "$WORK_DIR/artifacts/daytona/$TASK_ID"

# 5. Tear down when done
node "$SCRIPT" down --directory "$WORK_DIR"
```

### Adopt an existing sandbox

If a sandbox was created outside this script (e.g. via Daytona CLI directly):

```bash
node "$SCRIPT" adopt --directory "$WORK_DIR" --task-id "$TASK_ID" --sandbox-id "$SANDBOX_ID" --remote-path "/workspace/$TASK_ID"
```

### Check sandbox status

```bash
node "$SCRIPT" status --directory "$WORK_DIR"            # local cached state
node "$SCRIPT" status --directory "$WORK_DIR" --refresh   # force network check
```

### Preview a running service

```bash
node "$SCRIPT" preview --directory "$WORK_DIR" --port 3000
```

### Git-based sync (alternative to bundle push/pull)

When you need commit history preserved:

```bash
node "$SCRIPT" push --directory "$WORK_DIR" --mode git --branch "daytona/$TASK_ID"
# ... work remotely ...
node "$SCRIPT" pull --directory "$WORK_DIR" --mode git --branch "daytona/$TASK_ID"
```

Git mode transfers committed history only — uncommitted files are not included.

### Run a full smoke test

Validates the entire lifecycle in one command:

```bash
node "$SCRIPT" smoke-test --class small --include-git --include-preview
```

## When to read references

| You need to... | Read |
|---|---|
| Understand sandbox create/adopt/exec/delete in detail | `references/sandbox-lifecycle.md` |
| Push/pull files, choose bundle vs. git mode, handle artifacts | `references/artifact-workflows.md` |
| Find where state is stored, configure env vars and tokens | `references/state-and-secrets.md` |
| Debug stale status, command failures, secret leaks | `references/troubleshooting.md` |

## Non-negotiables

- **State is global.** Stored under `~/.daytona/claude-code/projects/`, keyed by project directory. Never store state in the project tree or skill source.
- **Never print secrets.** Env values and API tokens must not appear in output.
- **Quote shell arguments.** Remote commands go after `--`: `exec --directory "$WORK_DIR" -- pnpm test`.
- **Sandbox classes:** `small|medium|large` — default to `small` unless the workload needs more.
