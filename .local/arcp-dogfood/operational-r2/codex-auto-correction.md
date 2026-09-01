# Codex auto correction dogfood (redacted)

Date: 2026-09-01. Isolated loopback ARCP server and 0600 client state; credentials and Paseo handles are excluded.

- Public SDK `providers.listModes('codex')` returned IDs `auto`, `auto-review`, and `full-access`. CLI display labels were not used as the ID authority.
- `arcp actor register` and `arcp workspace create` printed `credentialStored: true`, not bearer values. Workspace creation saved the owner Member credential; `arcp member heartbeat --status idle` succeeded without a join.
- `arcp preflight --profile codex-worker` returned `action: launch` with requested/effective `mode: auto` and the three distinct live IDs above.
- Omitted-mode `arcp start --profile codex-worker` launched a disposable Codex runtime. Postflight and refreshed panorama both observed `mode: auto`, with no mismatch.
- Idle panorama showed observed context `24000/828400`, no pending permissions, healthy status, zero children, zero compactions (`none`), a path-free commit/diffstat, and redacted legacy counts.

The disposable Codex agent was archived; the isolated server and its temporary client/data/log state were removed afterward.
