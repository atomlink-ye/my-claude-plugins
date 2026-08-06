# Daytona adapter details

Daytona API inventory is authoritative. Local project state is a compatibility cache keyed by project directory; `sandbox-ctl run` uses an isolated temporary state directory and ignores legacy `.daytona/state.json`.

## Policies

Sandboxes carry managed labels: `sandbox-ctl.managed=true`, `sandbox-ctl.kind=sandbox`, `sandbox-ctl.adapter=daytona`, and `sandbox-ctl.policy=sandbox-v1`. User labels are preserved. Managed operations verify labels, policy, and identity; legacy managed objects are accepted only for read-only migration/adoption.

Unified defaults are `autoStopInterval=30`, `autoArchiveInterval=10080`, and `autoDeleteInterval=60` for every alias. `--auto-delete -1` disables deletion; `--auto-delete 0` deletes immediately after stop. `--ephemeral` normalizes auto-delete to zero.
Reuse validates the selected binding's lifecycle before remote operations.

## Transfers and execution

Bundle push excludes environment files, credentials, VCS metadata, dependencies, build output, and logs. Tar entries are validated before extraction. Git push/pull is limited to committed history and a `daytona/<task>` branch. Remote commands are shell-quoted and write `stdout.txt`, `stderr.txt`, `exit-code.txt`, and `manifest.json`. `exec` and `run` return the remote code exactly; a non-zero exec is pulled before cleanup.

`list` is inventory-only. `doctor` performs a read-only SDK list call and reports configuration/connection categories without secrets. `down` deletes only the exact managed sandbox represented by the selected binding, checking managed/kind/policy identity. Legacy hashed or `.daytona/state.json` state is read-only and migrated to local bindings on first successful resolution.
