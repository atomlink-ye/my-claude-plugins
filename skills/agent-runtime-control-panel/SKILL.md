---
name: agent-runtime-control-panel
description: "Coordinate a local agent team through the ARCP CLI: create a durable ControlWorkspace, register native or Paseo-managed Members, claim fenced Tasks, share Knowledge and Results, and manage safe-point runtime delivery. Use for local multi-agent collaboration, not raw HTTP composition."
---

# Agent Runtime Control Panel

ARCP is a local CLI-first control plane. Start with `arcp doctor`, `arcp ensure`, `arcp actor register`, then create or join a `ControlWorkspace`. Paseo is the first-class managed adapter; native Claude, Codex, Pi/Grok and Hermes may join as Members without Paseo.

Use `scripts/arcp`; the loopback API is internal durable transport. The CLI stores issued Actor/Member credentials in a mode-0600 local state file.

Normal messages queue until the recipient reaches a Paseo idle/terminal safe point. `delivery interrupt` is intentionally separate and may interrupt the active turn. Do not substitute `paseo send` for a normal ARCP delivery.

Do not pass provider handles, raw task prompts, secrets, or private host paths into API records. Launch by Goal and named profile. Profile discovery fails closed: ARCP never picks another provider or paid model for a caller.

See [README.md](README.md) for the local canary and [llms.txt](llms.txt) for the API map.
