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

`actor register`, `workspace create`, and `workspace join` save issued credentials to the mode-0600 client state and print `credentialStored:true`, never the bearer value. Pass `--show-credential` only for a deliberate one-time transfer. Workspace creation also provisions the owner's Member credential, so no follow-up join is needed before heartbeat, task claim, Knowledge, or Result commands.

## External Hermes ACP runtime

`external register` creates a sibling Hermes ACP on-call Runtime sharing this ARCP Workspace, Knowledge, and Delivery surface. It does not attach to the operator's existing Feishu Hermes conversation; that Feishu Hermes remains Owner and the human channel entry point. The real adapter uses the local `hermes acp` binary over stdio JSON-RPC.

Real canary (requires `hermes acp --check` to pass):

```sh
arcp external register WORKSPACE --label hermes-on-call
arcp external send RUNTIME --body 'Return a short canary Result through ARCP.'
arcp external status RUNTIME
arcp panorama --workspace WORKSPACE --refresh
arcp result list WORKSPACE
```

If `hermes` is absent, registration fails cleanly with an unavailable-runtime result; no fake adapter is used. A future ChannelBridge may map one ARCP Delivery onto a wake of one specific existing channel thread. That channel-side bridge is intentionally documentation-only here.

## MVE canary

```sh
root="$(mktemp -d)"
ARCP_API_KEY=test-key ARCP_RUNTIME_DIR="$root/run" ARCP_DATA="$root/data" PORT=18787 skills/agent-runtime-control-panel/scripts/ensure-running
ARCP_API_KEY=test-key ARCP_URL=http://127.0.0.1:18787 skills/agent-runtime-control-panel/scripts/arcp actor register hermes-owner --label Hermes
```

Then run the focused tests. For a real provider dogfood, run `arcp doctor`, then `arcp preflight --profile codex-worker`. Claude and Codex profiles deliberately resolve an omitted mode to `auto`; ARCP live-validates it and shows requested versus observed settings after launch. For unattended editing work, copy the exact elevation command from preflight, for example `arcp start --profile codex-full-access --title '<goal>' --unattended`; ARCP never upgrades a mode itself. `claude-bypass-permissions` is offered only when that live mode is available. Pi/Grok stays mode-less.

Use `arcp panorama --refresh` during work and `arcp runtime status RUNTIME --refresh` for the focused view. They project context/usage quality, attention, compaction only when observed, safe child descriptors, requested-vs-observed settings, a path-free commit/diffstat, and redacted legacy status counts. A launch timeout or absent handle is `transport_indeterminate`; call `runtime reconcile`, do not relaunch.

For Paseo-managed sessions, child observation merges parent-bound Agents with best-effort provider-owned subagents. Each item is limited to id/provider/title/status/timestamps and is labelled `provider_subagents`, `paseo_parent`, `none`, or `unavailable`; unavailable provider internals never block work.

For Claude, `interrupt` is deliberately two-stage and server-enforced: the first `arcp interrupt RUNTIME --reason X --body X` has no runtime side effect and returns a confirmation. Re-run the supplied command with `--confirm TOKEN`; ARCP re-observes the active turn and child set and rejects a stale token. Claude normal `send` and `reuse` use provider activity time: under 55 minutes is fresh; 55–60 is expiring; 60+ is expired. A hold offers a fresh-session handoff command or confirmed reuse. Panorama reports this activity age/cache state; ARCP never sends artificial keepalives or compacts to preserve cache.

## Compatibility

Existing `skills/paseo-companion/scripts/ensure-running` now starts this runtime. Existing imports under `skills/paseo-companion/paseo-reminder/src/*`, legacy environment variables, and all non-`/v1` routes forward to the same core.
