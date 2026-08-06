---
name: daytona-companion
description: "Deprecated compatibility shim; use sandbox-ctl for Daytona workflows."
---

# Deprecated Daytona companion

Use `sandbox-ctl` for all new work. The old script remains only for imports
and existing command invocations. The compatibility entrypoint is
`skills/daytona-companion/scripts/daytona-manager.mjs`; it forwards lifecycle
behavior to the canonical CLI. Read [sandbox-ctl](../sandbox-ctl/SKILL.md) for commands, JSON
contracts, transfer safety, and maintenance scope.

Legacy aliases (`create`, `task up`, `project up`, `finish`) are deprecated and
may emit a warning. This shim adds no provider, MCP server, daemon, Paseo
runtime, remote agent bootstrap, credential handling, or host cleanup.
