---
name: sandbox-ctl
description: "Use for a Daytona sandbox lifecycle, remote command, artifact transfer, preview, inventory, or safe diagnostics."
---

# sandbox-ctl

`sandbox-ctl` is the canonical offline-friendly CLI. Daytona is the only
adapter. Project bindings are read only from the exact current working
directory's `.sandbox-ctl/config.json`, or from `DIR/.sandbox-ctl/config.json`
when `--directory DIR` is supplied. Discovery never walks up to parent
directories. To use a root project's binding from a subdirectory—including
isolated worktrees or concurrent agents—pass `--directory <root>` explicitly.

## Short workflow

```sh
sandbox-ctl up [--name NAME] [--auto-stop 30 --auto-archive 10080 --auto-delete 60]
sandbox-ctl use NAME
sandbox-ctl exec -- COMMAND...                 # stream human output
sandbox-ctl exec --timeout 30m -- COMMAND...   # default foreground timeout: 5m
sandbox-ctl exec --json -- COMMAND...          # buffer one JSON object
sandbox-ctl exec --artifacts ./artifacts -- COMMAND...
sandbox-ctl push --mode bundle
sandbox-ctl pull --output ./artifacts
sandbox-ctl down --sandbox NAME
```

`--directory DIR` selects a project explicitly. `--sandbox NAME_OR_ID` selects
a binding for any operation without changing the active binding. A bare
`adopt` for a new binding requires `--remote-path PATH`; it may omit that flag
only when the exact directory's config binding or legacy state already has a
`remoteWorkspace`. `up --name`
creates or reuses a named binding; `use NAME` changes only the local active
selection. `--snapshot SNAPSHOT` selects the Daytona image for `up` or `run`.
`exec --timeout DURATION` accepts a positive integer with `ms`, `s`, `m`, or
`h`; a bare integer means seconds. Streaming exec defaults to `5m`. A timeout
only ends the local wait: the remote command status is unknown and it may still
be running.

`run -- COMMAND...` is a disposable composite: it creates a unique `run-*`
binding with `noUse=true`, performs a safe bundle push, executes with streaming
or buffered output, maps `--output PATH` to local `--artifacts PATH`, then
deletes that exact named binding. Remote non-zero codes are preserved after
local artifacts are written. The result always includes `bindingName`,
`configPath`, `sandboxId`, `exitCode`, `artifactPath`, `retained`, `warnings`,
`nextActions`, `stdout`, and `stderr`; `--json` emits one object. Control failures use exit 125. `run --keep` retains only a failed named binding and
returns `sandbox-ctl down --directory DIR --sandbox RUN_NAME` as the next action.

Defaults are three independent timers: idle stop after 30 minutes,
continuously-stopped permanent deletion after 60 minutes, and archive after
10080 minutes. Deletion normally happens first; archive is useful when
deletion is disabled with `--auto-delete -1`. `up` warns that data is lost
after permanent deletion. `--auto-delete 0` deletes immediately after stop;
`--ephemeral` is equivalent to zero deletion delay.

Bundle transfer excludes credentials, env files, VCS metadata, dependencies,
build output, and logs. Full transfer requires the two flags `--mode full
--include-sensitive`; archive links and special entries are always rejected.
Git sync uses a dedicated non-force branch. Git push snapshots tracked and
untracked WIP by default; `--committed-only` sends HEAD only, while
`--require-clean` rejects WIP (mutually exclusive, git push only). New
sensitive paths are rejected, local state is preserved, and unrelated/dirty
remote workspaces are refused. Pull still requires a clean remote.

Agents stay local. This workflow uses no MCP server, daemon, Paseo runtime,
remote agent bootstrap, provider credential injection, host cleanup, or
registry garbage collection. See [Daytona details](references/daytona.md) and
[maintenance](references/maintenance.md) for exact safety rules.

Legacy `create`, `task up`, and `project up` aliases are deprecated pointers to
`up`; use the canonical command in new scripts.
