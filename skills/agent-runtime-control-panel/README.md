# Agent Runtime Control Panel

ARCP is a standalone local, CLI-first control plane. A durable ControlWorkspace holds the team's purpose, Members, fenced Tasks, append-only Knowledge, Results and managed RuntimeSessions. `/v1/*` is internal durable transport for the `arcp` CLI.

## Start

```sh
pnpm --dir skills/agent-runtime-control-panel/runtime build
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp ensure
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp doctor
ARCP_API_KEY='choose-a-local-secret' skills/agent-runtime-control-panel/scripts/arcp actor register hermes-owner --channel hermes
```

Default durable state is `${XDG_STATE_HOME:-$HOME/.local/state}/agent-runtime-control-panel/data`. `ARCP_RUNTIME_DIR`, `ARCP_DATA`, `ARCP_LOG`, and `ARCP_PID` configure it. Legacy `PASEO_COMPANION_RUNTIME_DIR`, `PASEO_COMPANION_DATA`, `PASEO_COMPANION_LOG`, and `PASEO_COMPANION_PID` remain aliases. The server binds loopback only.

`actor register`, `workspace create`, and `workspace join` save issued credentials to the mode-0600 client state and print `credentialStored:true`, never the bearer value. Pass `--show-credential` only for a deliberate one-time transfer. Workspace creation also provisions the owner's Member credential, so no follow-up join is needed before heartbeat, task claim, Knowledge, or Result commands.

List commands use the same boundary as the existing context/panorama surface: a Member sees only its own Workspace, while an authenticated Actor or admin key is the deliberate discovery plane and may list all Workspaces.

## Provider budget MVE

`arcp provider-budget refresh` is operator/member controlled; `read` shows the last validated, redacted envelope. The bundled local source calls codexbar independently for Claude and Codex, so one provider failure cannot erase the other snapshot.

```json
{"providerBudget":{"sources":[{"id":"local-codexbar","kind":"codexbar","trust":"authoritative","estimated":false,"automaticAdmissionEligible":true}],"policies":[{"id":"default","maxAgeMs":300000,"drainRemainingPct":20,"hardDrainRemainingPct":10}],"bindings":[{"id":"claude-5h","providerId":"claude","sourceId":"local-codexbar","modelPatterns":["claude-opus-5","claude-sonnet-5"],"windowIds":["primary"],"admissionPolicyId":"default"}]}}
```

An external collector is explicit argv-only configuration, never an HTTP-selected command. Its stdout must be exactly one `arcp.provider-budget/v1` JSON object; ARCP uses a clean environment limited to `envAllowlist`, bounds time/output, and never persists stderr.

```json
{"id":"operator-collector","kind":"command","trust":"authoritative","estimated":false,"automaticAdmissionEligible":true,"command":["/absolute/path/to/collector"],"timeoutMs":30000,"maxOutputBytes":262144,"envAllowlist":[]}
```

An authoritative command collector must emit source-trust metadata with its envelope. The command and values below are generic examples; an operator supplies the actual executable and observed provider windows.

```json
{"schemaVersion":"arcp.provider-budget/v1","source":{"id":"operator-collector","kind":"command","observedAt":"2026-09-02T00:00:00Z","trust":"authoritative","estimated":false,"automaticAdmissionEligible":true},"providers":[{"providerId":"pi","status":"available","windows":[{"id":"weekly","label":"weekly","remainingPct":75}]}]}
```

The source configuration kind `codexbar` is an ARCP adapter choice; its emitted envelope deliberately has `source.kind: "command"`, because the envelope records the bounded local command observation. The default local CodexBar source is authoritative for Claude and Codex. Default Paseo-native envelopes emit `source.kind: "paseo"` but are advisory/estimated and cannot admit launches until an operator configures authoritative provider-specific trust. These identities remain separate from `source.id`, which policy bindings use.

Runtime status and Panorama also expose bounded aggregate burn samples: deduplicated native turn IDs, cache read/creation and output deltas, 5/10/60-minute velocity, turns/minute, stale retry wakes, context ratio, and `RATE_DRAIN`, `TURN_STORM`, `STALE_WAKE`, or `CONTEXT_DRAIN`. ARCP never reads or stores prompts or full transcripts.

Pi/Grok is an operator-configured, read-only `pi-grok-cache` source. The bundled config uses `${ARCP_PI_GROK_CACHE}`; set it to an absolute cache path (or override with an absolute `cachePath`) before refresh. The cache is refreshed by a Paseo Pi Agent running `/grok-cli-usage`; ARCP never invokes Pi or parses a transcript. Its envelope is explicitly `trust: "advisory"`, `estimated: true`, and `automaticAdmissionEligible: false`: it can be displayed with its freshness window, but it can never admit an automatic launch. Grok remains `hold_unknown` until an authoritative CodexBar or operator command envelope is configured. The frozen v1 envelope has only `paseo|command` kinds, so this cache emits `source.kind: "paseo"` to identify its required Paseo-refresh provenance, while `source.id` remains `pi-grok-cache`. Pi permission handling remains provider-managed: quota admission neither invents a bypass mode nor approves a permission request.

Native runtime burn attribution deduplicates observed turn IDs and always records turn/context facts. `wakeCategory` may remain `unknown`; ARCP does not claim live `STALE_WAKE` attribution until a provider-safe wake source is available. Paseo `lastUsage` is displayed as reported observation only: its per-turn semantics are not yet proven, so ARCP does not sum it as a token delta.

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

## Retired passive-reminder workflow

Port 8787, the `paseo-reminder` package, the unversioned reminder/message/child-watch/ledger/correction routes, the runtime that served them and the matching `arcp` verbs are removed. The daemon serves `/v1/*`, `/health` and `/self/runtime` and nothing else, and ARCP Channel, Delivery, Knowledge and Result are the only cooperation path; no proxy, shim or forwarding route is offered. `PASEO_COMPANION_RUNTIME_DIR`, `PASEO_COMPANION_DATA`, `PASEO_COMPANION_LOG` and `PASEO_COMPANION_PID` remain accepted as state-path names only, so an existing state directory stays readable.

Records written by the retired workflow are user data. Nothing in ARCP reads or writes them any more, so archive the directory with `scripts/archive-legacy-reminder-state --data DIR --out DIR` before a plugin reinstall or re-clone removes it; see `runtime/README.md`. Deleting the records is a separate Owner-gated step.
