# my-claude-plugins

Personal Claude Code plugin marketplace.

## Skills

The main bundled skills are shipped under a single plugin (`my-skills`).

| Skill | Description |
|-------|-------------|
| [agent-memory](skills/agent-memory/) | Local file-first Agent Memory with cross-project routing, stable IDs, lifecycle, duplicate-aware capture, Doctor, tags, FTS, and links/backlinks |
| [mve-first-development](skills/mve-first-development/) | Shape/Probe/Prove/Protect/Harden stage router for early product delivery |
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
| [paseo-companion](skills/paseo-companion/) | Paseo CLI runtime: agents, terminals, schedules, worktrees, host/port targeting |
| [agent-runtime-control-panel](skills/agent-runtime-control-panel/) | Durable local control plane for ARCP Actors, Goals, live-validated Paseo sessions, and safe-point deliveries |
| [google-workspace](skills/google-workspace/) | Google Docs/Drive/Sheets via the `gws` CLI |
| [mcp-skill](skills/mcp-skill/) | On-demand MCP server invocation via MCPorter |
| [figma-console](skills/figma-console/) | Schema-first local Figma Desktop Bridge workflow |

### Optional standalone plugins

`skill-creator` remains available as a standalone optional plugin.

### Upgrade notes

- `opencode-orchestrator` was folded into runtime-specific companion skills.
- `task-iteration`, `agentic-orchestration`, and `team-lead-orchestration` were removed from the bundle.
- `daytona-companion` was removed; sandbox lifecycle is superseded by `sandbox-ctl`.
- `paseo-reminder` is retained as a compatibility entrypoint and now runs from `agent-runtime-control-panel/runtime`.

## Agent Memory quick start

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/setup.sh"
agent-memory sync
agent-memory doctor --path "$WORK_DIR"
agent-memory search "learnings agent server" --path "$WORK_DIR"
agent-memory capture learning "Reusable learning" --path "$WORK_DIR"
agent-memory lifecycle mem_abc promoted --target mem_canonical
```

Stable cross-project references use `memory://mem_xxx`. Legacy Markdown remains valid; explicit ID migration is available through `skills/agent-memory/scripts/migrate_ids.py`.

See [docs/agent-memory.md](docs/agent-memory.md) and [docs/agent-memory-doctor.md](docs/agent-memory-doctor.md).

## Installation

Configure this repository as a local directory or GitHub Claude Code marketplace, then enable `my-skills@my-claude-plugins`.

## Development

```bash
pnpm install
pnpm test
python3 -m unittest discover -s eval/agent-memory/tests -p 'test_*.py'
```
