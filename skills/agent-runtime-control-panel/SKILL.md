---
name: agent-runtime-control-panel
description: Coordinate agent teams through a durable local CLI.
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

Use `scripts/arcp`; the loopback API is internal durable transport. The CLI stores issued Actor/Member credentials in a mode-0600 local state file.

Normal messages queue until the recipient reaches a Paseo idle/terminal safe point. `delivery interrupt` is intentionally separate and may interrupt the active turn. Do not substitute `paseo send` for a normal ARCP delivery.

Do not pass provider handles, raw task prompts, secrets, or private host paths into API records. Launch by Goal and named profile. Profile discovery fails closed: ARCP never picks another provider or paid model for a caller.

See [README.md](README.md) for the local canary and [llms.txt](llms.txt) for the CLI map.
