# Daytona adapter details

The adapter is deliberately narrow: it creates and deletes only managed
Daytona sandboxes represented by a local named binding. Bindings are the source
of truth for normal commands; legacy hashed state is read-only compatibility
input and is migrated only when explicitly resolved.

## Lifecycle

Managed labels are `sandbox-ctl.managed=true`, `sandbox-ctl.kind=sandbox`,
`sandbox-ctl.adapter=daytona`, and `sandbox-ctl.policy=sandbox-v1`. Every
`up` path uses independent stop/archive/delete timers of 30/10080/60 minutes:
idle sandboxes stop at 30, continuously-stopped sandboxes delete at 60, and
archive runs at 10080 when deletion is disabled. Reuse checks the selected
binding's identity; reuse lifecycle settings are validated before remote
operations. `run` always creates a
unique `run-*` binding with `noUse=true`, and cleanup addresses that exact name.

## Transfer and execution

Bundle mode is the safe default. It excludes env files, credentials, VCS data,
dependencies, build output, logs, and `.sandbox-ctl`; tar entries are checked
before extraction and links/special files are rejected. Full mode is opt-in
with both `--mode full` and `--include-sensitive`.

Git mode uses a dedicated non-force branch and preserves the local repository.
By default `push --mode git` snapshots committed HEAD plus tracked/staged/
unstaged changes, deletions, renames, and nonignored untracked files. Use
`--committed-only` for HEAD-only snapshots or `--require-clean` to reject WIP;
these flags are mutually exclusive and push-only. Newly added sensitive paths
are rejected. Remote workspaces must be clean and either empty, related to the
source history, or carry valid sandbox-ctl snapshot metadata; unrelated human
repositories are never replaced. Pull behavior remains clean-remote only.

`exec` streams output when the SDK supports sessions and buffers otherwise.
The streaming-session client deadline defaults to five minutes and can be set
with `--timeout 500ms|30s|5m|1h` (a bare integer means seconds). This is a local
wait deadline, not a confirmed remote command timeout: after it expires, the
remote command status is unknown and it may still be running. `sandbox-ctl`
does not delete the Daytona process session on this timeout. Older SDK
fallbacks expose only a synchronous buffered call, so the client cannot enforce
the timeout on that path; the result includes an explicit warning.
`--json` emits one object; `--artifacts DIR` writes `stdout.txt`, `stderr.txt`,
`exit-code.txt`, and `manifest.json` locally. `run --output DIR` maps to that
local artifact directory. Remote exit codes are returned exactly; control
errors return 125. Artifact writing completes before a remote non-zero result
is cleaned up.

`list` and `doctor` are read-only inventory/diagnostic calls. `down` checks
managed labels and identity, then deletes only the exact selected binding.
