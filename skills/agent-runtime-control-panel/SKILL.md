---
name: agent-runtime-control-panel
description: "Run the local Agent Runtime Control Panel (ARCP): register stable agent actors, create goals, live-validate Paseo launch profiles, launch/observe/reconcile runtime sessions, and send durable safe-point or explicit interrupt deliveries. Use whenever coordinating local Claude, Codex, or Pi/Grok runtimes through a durable API."
---

# Agent Runtime Control Panel

ARCP is the local control plane for stable Actors, Goals, Paseo-backed RuntimeSessions, and durable Inbox deliveries. Paseo is the V1 adapter; Claude, Codex, and Pi/Grok are providers selected only from live-validated profiles.

Start the singleton with `scripts/ensure-running`. Set `ARCP_API_KEY` before starting it, then use `scripts/arcp` for the authenticated Client API. `PASEO_COMPANION_*` names remain legacy aliases; use `ARCP_*` for new configuration.

Normal messages queue until the recipient reaches a Paseo idle/terminal safe point. `delivery interrupt` is intentionally separate and may interrupt the active turn. Do not substitute `paseo send` for a normal ARCP delivery.

Do not pass provider handles, raw task prompts, secrets, or private host paths into API records. Launch by Goal and named profile. Profile discovery fails closed: ARCP never picks another provider or paid model for a caller.

See [README.md](README.md) for the local canary and [llms.txt](llms.txt) for the API map.
