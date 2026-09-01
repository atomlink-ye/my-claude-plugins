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

`UPSTREAM.md` records the observed Paseo daemon gaps this runtime works around,
including the two public transports it relies on: `paseo send --no-wait` reaches
a running recipient and appears as a complete turn in `paseo logs`, while a
repeating heartbeat skips busy ticks and runs after idle. Heartbeat prompt
content is never rendered in `paseo logs`, which is why delivery acceptance is
confirmed from durable ARCP Delivery state rather than from a transcript.

## Retired passive-reminder state

Port 8787, the `paseo-reminder` package and the passive reminder/child-watch/
correction-gate workflow are retired. ARCP is the only cooperation path; no
proxy, shim or forwarding route is offered.

The reminder, message, child-watch, ledger and correction records written by
that workflow are user data and still exist on disk. They are not a supported
cooperation surface and must not be used as one. Archive them before any
plugin reinstall removes the directory that holds them:

```sh
skills/agent-runtime-control-panel/scripts/archive-legacy-reminder-state \
  --data /path/to/.paseo-reminder \
  --out  /path/to/legacy-reminder-archive-YYYYMMDD
```

The archive is a verified copy with a `MANIFEST.json` of per-file record counts
and SHA-256 digests. It never moves or deletes the source. Deleting the records,
and removing the code that reads them, is a separate Owner-gated step that
requires this archive to exist first.
