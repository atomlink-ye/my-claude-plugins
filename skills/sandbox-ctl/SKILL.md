---
name: sandbox-ctl
description: "Use for a Daytona or Cube Sandbox lifecycle, remote command, artifact transfer, preview, inventory, or safe diagnostics."
---

# sandbox-ctl

`sandbox-ctl` is the canonical CLI with Daytona and Cube Sandbox adapters.
Bindings come only from the exact directory's `.sandbox-ctl/config.json` (or
`--directory DIR`); discovery never walks upward. From a subdirectory or
worktree, pass the root explicitly.

## Short workflow

```sh
sandbox-ctl up --template TEMPLATE_ID [--name NAME]  # Cube Sandbox
sandbox-ctl use NAME
sandbox-ctl exec -- COMMAND...                 # stream human output
sandbox-ctl exec --timeout 30m -- COMMAND...   # default foreground timeout: 5m
sandbox-ctl exec --json -- COMMAND...          # buffer one JSON object
sandbox-ctl exec --artifacts ./artifacts -- COMMAND...
sandbox-ctl push --mode bundle
sandbox-ctl pull --output ./artifacts
sandbox-ctl down --sandbox NAME
sandbox-ctl --adapter cube-sandbox daemon status
sandbox-ctl --adapter cube-sandbox config set
sandbox-ctl --adapter cube-sandbox config status
sandbox-ctl --adapter cube-sandbox config path
```

`--directory DIR` selects a project; `--sandbox NAME_OR_ID` selects a binding
without changing it. Bare `adopt` requires `--remote-path PATH` unless the
binding already records a workspace. `up --name` creates/reuses; `use NAME`
selects. A new Cube Sandbox binding requires `--template`; reuse reads the
stored template. `--snapshot` is Daytona-only. Adapter priority is explicit flag,
exact config, then Cube Sandbox. Use `cube-sandbox`; `cube` is deprecated.
`exec --timeout DURATION` accepts positive integers with `ms`, `s`, `m`, or `h`
(bare integer = seconds); streaming defaults to `5m`. Timeout ends only the
local wait.

`run -- COMMAND...` creates a unique disposable binding, safely bundle-pushes,
executes, writes optional artifacts, then deletes that exact binding. Remote
exit codes survive; control failures use 125. `--json` emits one object.
`run --keep` retains failures and returns an exact cleanup command.
Results identify `bindingName` and `configPath` for deterministic follow-up.

Daytona defaults are independent timers: idle stop after 30 minutes, permanent
deletion after 60 continuously-stopped minutes, and archive after 10080 minutes.
Cube Sandbox uses a per-user background daemon for command execution and a
single idle timeout (30 minutes by default); inspect it with `daemon status`,
start it explicitly with `daemon start`, and stop it with `daemon stop`.
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

Agents stay local. No MCP, Paseo runtime, remote agent bootstrap, host cleanup,
or registry garbage collection. Cube's per-user daemon owns only the local SDK
connection. Cube credentials may be kept in the per-user global config (mode
0600); project `.sandbox-ctl/config.json` remains secret-free. See
[Daytona](references/daytona.md), [Cube Sandbox](references/cube-sandbox.md),
and [maintenance](references/maintenance.md).

Legacy `create`, `task up`, and `project up` aliases are deprecated pointers to
`up`; use the canonical command in new scripts.
