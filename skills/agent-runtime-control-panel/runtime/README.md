# Agent Runtime Control Panel runtime

Local loopback daemon behind the `arcp` CLI. It holds the durable
ControlWorkspace — Members, fenced Tasks, append-only Knowledge, Results,
ChannelEvents, Deliveries and managed RuntimeSessions — and invokes only the
public `paseo` CLI, so daemon state stays authoritative.

```sh
pnpm install
pnpm build
PORT=18787 node dist/server.js
```

Start or reuse it through `skills/agent-runtime-control-panel/scripts/ensure-running`,
which keeps state, logs and pid files outside this source tree. `ARCP_RUNTIME_DIR`,
`ARCP_DATA`, `ARCP_LOG` and `ARCP_PID` configure those paths; the corresponding
`PASEO_COMPANION_*` names remain accepted so an existing state directory stays
readable. The server binds loopback only and requires `ARCP_API_KEY`, an Actor
credential, or a Member credential on every route except `/health`.

The `/v1/*` surface is the transport for the `arcp` CLI. Cooperation between
agents happens through ARCP Channel, Delivery, Knowledge and Result — see
`../README.md` for the command surface and `../SKILL.md` for agent-facing usage.

## Upstream Paseo constraints

`UPSTREAM.md` records the observed Paseo daemon gaps this runtime works around:
no push when a child reaches a terminal state, `ls -g --json` without
`ParentAgentId`, and the fact that only `paseo send --no-wait` content appears
in `paseo logs`. Delivery acceptance is therefore confirmed from durable ARCP
Delivery state rather than from a transcript, and acceptance means daemon
receipt rather than proof the recipient processed the prompt.

## Retired passive-reminder state

Port 8787, the `paseo-reminder` package, the unversioned reminder/message/
child-watch/ledger/correction routes and the runtime that served them are
removed. This daemon serves `/v1/*`, `/health` and `/self/runtime` and nothing
else. ARCP Channel, Delivery, Knowledge and Result are the only cooperation
path; no proxy, shim or forwarding route is offered.

Records written by the retired workflow are user data. Nothing in this runtime
reads or writes them any more, so archive the directory before a plugin
reinstall or re-clone removes it:

```sh
skills/agent-runtime-control-panel/scripts/archive-legacy-reminder-state \
  --data /path/to/.paseo-reminder \
  --out  /path/to/legacy-reminder-archive-YYYYMMDD
```

The archive is a verified copy with a `MANIFEST.json` of per-file record counts
and SHA-256 digests. It never moves or deletes the source. Deleting the records
is a separate Owner-gated step that requires this archive to exist first.
