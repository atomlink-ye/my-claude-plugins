---
name: agent-runtime-control-panel
description: Coordinate agent runtimes through a local CLI.
version: 0.1.0
author: atomlink-ye, Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [agents, control-plane, paseo, cli]
---

# Agent Runtime Control Panel

ARCP is a local CLI-first control plane. Start with `arcp doctor`, `arcp ensure`, `arcp actor register`, then create or join a `ControlWorkspace`. Paseo is the first-class managed adapter; native Claude, Codex, Pi/Grok and Hermes may join as Members without Paseo.

Use `scripts/arcp`; the loopback API is internal durable transport. The CLI stores issued Actor/Member credentials in a mode-0600 local state file and prints only `credentialStored:true`. Use the explicit one-time `--show-credential` option only when transferring a credential deliberately. `workspace create` also stores the owner Member credential, so the owner can immediately heartbeat, claim Tasks, add Knowledge, and submit Results.

Normal messages queue until the recipient reaches a Paseo idle/terminal safe point. `delivery interrupt` is intentionally separate and may interrupt the active turn. Do not substitute `paseo send` for a normal ARCP delivery.

Claude interrupt is two-stage: `arcp interrupt RUNTIME --reason X --body X` returns a short-lived confirmation without changing the runtime; repeat its exact command with `--confirm TOKEN` to re-observe and interrupt. Claude normal send/reuse checks provider activity (not ARCP observation time): fresh under 55 minutes, expiring at 55–60, expired at 60+. Held reuse offers an exact fresh-session handoff command or `arcp reuse ... --confirm TOKEN`; ARCP never sends cache keepalives or forces compaction.

Do not pass provider handles, raw task prompts, secrets, or private host paths into API records. Start with `arcp preflight`; omitted Claude/Codex mode resolves to live-validated `auto`. `arcp start` never silently elevates: use the preflight's exact `codex-full-access` or `claude-bypass-permissions` command when an unattended/editing Goal needs it. Pi/Grok remains mode-less. Use `arcp panorama --refresh` and `arcp runtime status ID --refresh` for safe telemetry, children, SCM and compatibility counts. Profile discovery fails closed: ARCP never picks another provider or paid model for a caller.

See [README.md](README.md) for the local canary and [llms.txt](llms.txt) for the CLI map.
