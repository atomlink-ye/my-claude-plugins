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

## Never block on a human

An unattended runtime must not wait on an interactive prompt. When a question or permission request arises, raise it as a durable event and keep working: `arcp channel ask RUNTIME --question '...' --options 'a,b'` writes a `decision_required` ChannelEvent addressed to the Workspace owner and records, on the runtime itself, that it is blocked and since when. That record is written at the moment the prompt is raised because it cannot be recovered later — a runtime waiting on an in-turn question reports the same `state=running, lastTurnState=running` as a healthy one, so `runtime status` alone will never reveal it. `arcp panorama` and `arcp tui --snapshot` show every blocked runtime with its age.

The Owner Deputy answers with `arcp channel resolve EVENT --summary '...' --verdict accept|refuse`. The verdict is the judgement, not the prose: only `accept` completes the Task the decision was holding, and a refusal leaves it open for rework. Answering releases the runtime's blocked record.

Only an irreversible external Human Gate may stay blocked. For everything else, take the safe reversible option rather than waiting: record the decision and the evidence that supports it with `arcp knowledge add --kind decision`, retry the external step on a bounded loop, and continue. If the loop exhausts its bound, publish a `blocker` Knowledge entry naming the gate and move to work that does not depend on it. A verdict that exists only in a provider transcript is not a durable decision.

See [README.md](README.md) for the local canary and [llms.txt](llms.txt) for the CLI map.
