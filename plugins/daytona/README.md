# Daytona Claude Code Plugin

Manage a Daytona sandbox for the current project using project-local state in `.daytona/state.json`.

## Commands

- `/daytona:up` — create or reconnect a sandbox.
- `/daytona:status` — show safe local state; add `--refresh` to query Daytona.
- `/daytona:push --path PATH` — bundle and upload a file or directory to the remote workspace. Directory pushes extract the directory contents directly into the workspace.
- `/daytona:exec -- COMMAND...` — run a command in the sandbox and write artifacts remotely.
- `/daytona:pull` — download remote artifact contents directly to `artifacts/daytona/<task-id>`.
- `/daytona:down` — delete the sandbox and remove state unless `--keep-state` is set.

Install `@daytona/sdk` where the plugin script can resolve it before using network-backed commands. `--help` and non-refresh `status` do not require the SDK.

Secrets may be loaded with `--env-file .env.local`; values are never printed by the manager.
