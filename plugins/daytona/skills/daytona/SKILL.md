---
name: daytona
description: Runtime contract for managing Daytona sandboxes from Claude Code. Load when the user asks to create, inspect, push to, execute in, pull artifacts from, or delete a Daytona sandbox.
user-invocable: false
---

# Daytona Sandbox Manager Skill

Use the plugin commands first; call the script directly only for low-level control:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/daytona-manager.mjs" <command> [options]
```

## Contract

- State is project-local: `.daytona/state.json` under `--directory` or cwd.
- Do not store state in the plugin source tree.
- Do not print secret env values. `--env-file` may load `.env.local`, and `DAYTONA_API_TOKEN` is accepted as `DAYTONA_API_KEY` for SDK use.
- `status` should avoid Daytona SDK/network calls unless `--refresh` is explicitly supplied.
- Unit tests must not use real Daytona network calls.

## Commands

```bash
daytona-manager.mjs up [--directory DIR] [--task-id ID] [--snapshot SNAPSHOT] [--name NAME] [--env-file FILE]
daytona-manager.mjs status [--directory DIR] [--refresh]
daytona-manager.mjs push [--directory DIR] [--task-id ID] --path PATH [--remote-path PATH] [--mode bundle]
daytona-manager.mjs exec [--directory DIR] [--cwd PATH] -- COMMAND...
daytona-manager.mjs pull [--directory DIR] [--output DIR] [--remote-path PATH]
daytona-manager.mjs down [--directory DIR] [--keep-state]
```

`push` currently supports bundle mode only. Git mode is planned.
