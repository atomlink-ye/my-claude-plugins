---
name: daytona-companion
description: "Daytona sandbox companion skill. Load for old /daytona:* command terms, sandbox up/status/push/exec/pull/down requests, artifact workflows, global project-scoped Daytona state, env/secrets handling, and questions about the removed slash-command wrappers. Commands are replaced by direct daytona-manager calls under skills/daytona-companion/scripts."
user-invocable: true
---

# Daytona Companion

The old `/daytona:*` slash commands are removed/replaced. Use this top-level skill and the manager script directly.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" <command> [options]
```

When this skill is installed standalone for OpenCode under `~/.agents/skill/`, use:

```bash
node "$HOME/.agents/skill/daytona-companion/scripts/daytona-manager.mjs" <command> [options]
```

## Quick map from old commands

- `/daytona:up` → `up [--directory DIR] [--task-id ID] ...`
- `/daytona:status` → `status [--directory DIR] [--refresh]`
- `/daytona:push` → `push --path PATH [--remote-path PATH]`
- `/daytona:exec` → `exec -- COMMAND...`
- `/daytona:pull` → `pull [--output DIR] [--remote-path PATH]`
- `/daytona:down` → `down [--keep-state]`

## Read next

- `references/sandbox-lifecycle.md` — create/status/exec/delete
- `references/artifact-workflows.md` — push/pull bundles and artifacts
- `references/state-and-secrets.md` — global project-scoped state and secret redaction
- `references/command-migration.md` — old command replacements
- `references/troubleshooting.md` — common failures and safe recovery

## Non-negotiables

- Daytona state is global under `~/.daytona/claude-code/projects/`, keyed by project directory.
- Do not store state in the project tree or skill/plugin source tree.
- Do not print secret env values.
- Quote shell arguments; pass remote commands after `--`.
