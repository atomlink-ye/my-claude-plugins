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

`--directory DIR` selects a project; `--sandbox NAME_OR_ID` selects a binding
without changing active binding. Bare `adopt` requires `--remote-path PATH`; omit
it only when the exact config binding has `remoteWorkspace` or legacy/project
state has `remoteWorkspacePath`. `up --name` creates/reuses a binding; `use NAME` changes
local selection. `--snapshot SNAPSHOT` selects the Daytona image for `up`/`run`.
`exec --timeout DURATION` accepts positive integers with `ms`, `s`, `m`, or `h`
(bare integer = seconds); streaming defaults to `5m`. Timeout ends only the
local wait: remote status may remain unknown.

`run -- COMMAND...` is disposable: it creates a unique `run-*` binding
(`noUse=true`), safely bundle-pushes, executes with streaming or buffered output,
maps `--output PATH` to local `--artifacts PATH`, then deletes that exact
binding. Remote non-zero codes survive artifact writing. Its
result includes `bindingName`, `configPath`, `sandboxId`, `exitCode`,
`artifactPath`, `retained`, `warnings`, `nextActions`, `stdout`, and `stderr`;
`--json` emits one object. Control failures use exit 125. `run --keep` retains
a failed binding and returns `sandbox-ctl down --directory DIR --sandbox
RUN_NAME`.

Defaults are independent timers: idle stop after 30 minutes, permanent deletion
after 60 continuously-stopped minutes, and archive after 10080 minutes.
Deletion normally happens first; archive is useful with `--auto-delete -1`.
`up` warns permanent deletion loses data. `--auto-delete 0` deletes immediately
after stop; `--ephemeral` means zero deletion delay.

Bundle transfer excludes credentials, env files, VCS metadata, dependencies,
build output, and logs. Full transfer requires `--mode full --include-sensitive`;
archive links and special entries are rejected. Git sync uses a dedicated
non-force branch. Git push includes tracked/untracked WIP by default;
`--committed-only` sends HEAD only; `--require-clean` rejects WIP (mutually
exclusive; git push only). Sensitive paths rejected; local state preserved;
unrelated/dirty remotes refused. Pull requires a clean remote.

Agents stay local. This workflow uses no MCP server, daemon, Paseo runtime,
remote agent bootstrap, provider credential injection, host cleanup, or
registry garbage collection. See [Daytona details](references/daytona.md) and
[maintenance](references/maintenance.md) for exact safety rules.

Legacy `create`, `task up`, and `project up` aliases are deprecated pointers to
`up`; use the canonical command in new scripts.
