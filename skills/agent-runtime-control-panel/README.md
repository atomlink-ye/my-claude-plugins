# Agent Runtime Control Panel

ARCP is a standalone local, CLI-first control plane. A durable ControlWorkspace holds the team's purpose, Members, fenced Tasks, append-only Knowledge, Results and managed RuntimeSessions. Its unversioned reminder/watch/message/correction/gate API remains compatible with `paseo-companion`; `/v1/*` is internal transport for the CLI.

## Start

```sh
pnpm --dir skills/agent-runtime-control-panel/runtime build
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp ensure
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp doctor
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp actor register hermes-owner --channel hermes
```

Default durable state is `${XDG_STATE_HOME:-$HOME/.local/state}/agent-runtime-control-panel/data`. `ARCP_RUNTIME_DIR`, `ARCP_DATA`, `ARCP_LOG`, and `ARCP_PID` configure it. Legacy `PASEO_COMPANION_RUNTIME_DIR`, `PASEO_COMPANION_DATA`, `PASEO_COMPANION_LOG`, and `PASEO_COMPANION_PID` remain aliases. The server binds loopback only.

## MVE canary

```sh
root="$(mktemp -d)"
ARCP_API_KEY=test-key ARCP_RUNTIME_DIR="$root/run" ARCP_DATA="$root/data" PORT=18787 skills/agent-runtime-control-panel/scripts/ensure-running
ARCP_API_KEY=test-key ARCP_URL=http://127.0.0.1:18787 skills/agent-runtime-control-panel/scripts/arcp actor register hermes-owner --label Hermes
```

Then run the focused tests. For a real provider dogfood, run `arcp doctor`, then `arcp preflight --profile codex-worker`. Claude and Codex profiles deliberately resolve an omitted mode to `auto`; ARCP live-validates it and shows requested versus observed settings after launch. For unattended editing work, copy the exact elevation command from preflight, for example `arcp start --profile codex-full-access --title '<goal>' --unattended`; ARCP never upgrades a mode itself. `claude-bypass-permissions` is offered only when that live mode is available. Pi/Grok stays mode-less.

Use `arcp panorama --refresh` during work and `arcp runtime status RUNTIME --refresh` for the focused view. They project context/usage quality, attention, compaction only when observed, safe child descriptors, requested-vs-observed settings, a path-free commit/diffstat, and redacted legacy status counts. A launch timeout or absent handle is `transport_indeterminate`; call `runtime reconcile`, do not relaunch.

## Compatibility

Existing `skills/paseo-companion/scripts/ensure-running` now starts this runtime. Existing imports under `skills/paseo-companion/paseo-reminder/src/*`, legacy environment variables, and all non-`/v1` routes forward to the same core.
