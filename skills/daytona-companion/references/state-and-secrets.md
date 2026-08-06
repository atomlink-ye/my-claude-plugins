# Deprecated state and secrets reference

State and secret handling is defined by the canonical
[`sandbox-ctl` skill](../../sandbox-ctl/SKILL.md). New bindings are local,
project-scoped `.sandbox-ctl/config.json` records and contain IDs and paths,
never tokens or env-file contents. Legacy `.daytona/state.json` is read-only
compatibility input.

Never print provider credentials or copy them into a sandbox. For audits use
`sandbox-ctl doctor --json`; it redacts configured credentials.
