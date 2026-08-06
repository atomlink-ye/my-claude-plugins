# Deprecated troubleshooting reference

Use the canonical [`sandbox-ctl` skill](../../sandbox-ctl/SKILL.md) and its
[Daytona reference](../../sandbox-ctl/references/daytona.md). Keep agents
local, pass commands after `--`, and inspect failures with `--json`.

This compatibility shim does not start daemons, run Paseo, bootstrap remote
agents, repair provider runtimes, or perform host cleanup. Never put provider
credentials in a sandbox.
