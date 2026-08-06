---
name: sandbox-ctl
description: "Use when a task needs a Daytona sandbox lifecycle, remote command execution, artifact transfer, preview, inventory, or non-destructive diagnostics."
---

# sandbox-ctl

The canonical command is `sandbox-ctl`; Daytona is the default and only adapter. It stores local bindings in the nearest `.sandbox-ctl/config.json` (schemaVersion 1) and keeps legacy state read-only for migration. `task up`, `project up`, and `create` are deprecated aliases for `up` and emit a warning.

## Quick reference

```sh
sandbox-ctl up --directory "$WORK" --name "$NAME"
sandbox-ctl status --directory "$WORK" [--refresh]
sandbox-ctl list [--json]
sandbox-ctl doctor [--json]
sandbox-ctl push --directory "$WORK" --path "$WORK" [--mode bundle|git]
sandbox-ctl exec --directory "$WORK" -- COMMAND...
sandbox-ctl pull --directory "$WORK" --output "$OUT" [--mode bundle|git]
sandbox-ctl down --directory "$WORK"
sandbox-ctl adopt --directory "$WORK" --sandbox-id "$SANDBOX_ID"
sandbox-ctl preview --directory "$WORK" --port 3000
sandbox-ctl smoke-test
sandbox-ctl run --directory "$WORK" --task-id "$TASK" --snapshot "$SNAPSHOT" --output "$OUT" --json --keep -- COMMAND...
```

Bundle mode transfers files; git mode transfers committed history and uses a `daytona/<task>` branch. `run` composes `up`, bundle push, exec, artifact pull, and finish. Put command arguments after `--`. `--json` emits one object with `ok`, `command`, `adapter`, `sandboxId`, `exitCode`, `artifactPath`, `retained`, `warnings`, `nextActions`, `stdout`, and `stderr`. Remote non-zero exit codes are preserved and artifacts are pulled first. A failed `run --keep` returns a quoted `nextActions` command and retains its temporary state.

The stable `run --json` result follows this schema; `error` is present only on failure:

```json
{"type":"object","required":["ok","command","adapter","sandboxId","stateDirectory","exitCode","artifactPath","retained","warnings","nextActions","stdout","stderr"],"properties":{"stateDirectory":{"type":"string"},"error":{"type":"string"}}}
```

`stateDirectory` identifies the isolated local state used by the run. A failed result may add an optional string `error`.

Execution artifacts are `stdout.txt`, `stderr.txt`, `exit-code.txt`, and `manifest.json`.

Unified sandbox policy defaults are stop 30 minutes, archive 10080 minutes, and delete 60 minutes. `--auto-delete -1` disables deletion and `0` deletes immediately after stop. The successful `up` output warns that data not pulled back before permanent deletion will be lost.

Agents remain local; remote commands run directly in the sandbox. Do not put provider credentials in remote agent environments. This skill does not use MCP, daemons, host cleanup, registry GC, or a second provider.

Read [Daytona details](references/daytona.md) for lifecycle and transfer safety, and [maintenance](references/maintenance.md) for read-only audits and two-phase cleanup planning.
