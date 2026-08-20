# my-claude-plugins

Personal Claude Code plugin marketplace.

## Skills

The main bundled skills are shipped under a single plugin (`my-skills`).

| Skill | Description |
|-------|-------------|
| [mve-first-development](skills/mve-first-development/) | Shape/Probe/Prove/Protect/Harden stage router for early product delivery; defaults to a real minimum verifiable E2E slice before contract freezing or production hardening |
| [team-lead-orchestration](skills/team-lead-orchestration/) | Runtime-neutral principles for the team-lead role: lead/lane split, bounded execution lanes, and acceptance gates |
| [agent-memory](skills/agent-memory/) | Local file-first Agent Memory registry: nested project routing, Markdown source files, SQLite FTS5/tag-aware search, hierarchical tags, capture, and links/backlinks across projects |
| [self-improvement](skills/self-improvement/) | Capture policy for learnings, drawbacks, errors, corrections, and feature requests; persists them through Agent Memory instead of a CWD-local `.learnings/` silo |
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
| [daytona-companion](skills/daytona-companion/) | Daytona sandbox lifecycle, global project-scoped state, and artifact workflows |
| [paseo-companion](skills/paseo-companion/) | Paseo CLI runtime: agents, terminals, schedules, worktrees, host/port targeting |
| [google-workspace](skills/google-workspace/) | Google Docs/Drive/Sheets via the `gws` CLI |
| [mcp-skill](skills/mcp-skill/) | On-demand MCP server invocation via MCPorter |
| [figma-console](skills/figma-console/) | Schema-first local Figma Desktop Bridge workflow with verified reads, edits, screenshots, and deterministic HTML/CSS export |

### Optional standalone plugins

Some skills are also available as separate opt-in plugins and are not included in the `my-skills` bundle.

| Plugin | Skill | Description |
|--------|-------|-------------|
| `skill-creator` | [skill-creator](skills/skill-creator/) | Vendored fork for creating, evaluating, packaging, and improving Claude Code skills with configurable CLI runners |

### Upgrade notes

The `my-skills` bundle now keeps runtime adapters and generic orchestration only. Legacy public skills that mixed workflow policy with local implementation details were removed from the bundle and source tree:

- `opencode-orchestrator`: generic orchestration guidance moved to [team-lead-orchestration](skills/team-lead-orchestration/); OpenCode runtime commands remain in [opencode-companion](skills/opencode-companion/).
- `task-iteration`: plan execution should be handled by the active agent workflow using [team-lead-orchestration](skills/team-lead-orchestration/) plus the selected runtime adapter.
- `agentic-orchestration`: renamed to [team-lead-orchestration](skills/team-lead-orchestration/) — same skill, clearer trigger surface around the team-lead framing.
- `debug-workflow`: browser, documentation, repository, and web-search MCP access should go through [mcp-skill](skills/mcp-skill/) when needed; runtime-specific execution stays in the companion skills.

Companion skills expose direct script entrypoints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new --directory "$WORK_DIR" -- "<prompt>"
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" status --directory "$WORK_DIR"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json search "learnings agent server" --path "$WORK_DIR"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json capture learning "Reusable learning" --path "$WORK_DIR"
```

The Agent Memory design and settings contract are documented in [docs/agent-memory.md](docs/agent-memory.md).

## Installation

### Local (recommended for development)

```json
{
  "extraKnownMarketplaces": {
    "my-claude-plugins": {
      "source": {
        "source": "directory",
        "path": "/path/to/my-claude-plugins"
      }
    }
  }
}
```

### GitHub

```json
{
  "extraKnownMarketplaces": {
    "my-claude-plugins": {
      "source": {
        "source": "github",
        "repo": "atomlink-ye/my-claude-plugins"
      }
    }
  }
}
```

Then enable the bundled plugin:

```json
{
  "enabledPlugins": {
    "my-skills@my-claude-plugins": true
  }
}
```

To enable the standalone optional skill creator plugin instead of (or in addition to) the bundled plugin:

```json
{
  "enabledPlugins": {
    "skill-creator@my-claude-plugins": true
  }
}
```

## Development

```bash
pnpm install
pnpm test
```

## Evaluating skills

Per-skill triggers, outcomes, smoke and unit tests live under [`eval/<skill>/`](eval/). The repo follows the skill-creator eval schema.

```bash
# Trigger eval for one skill (default runner: `claude`)
eval/_shared/run-trigger-eval.sh opencode-companion

# Smoke/unit tests (offline-safe)
eval/opencode-companion/tests/smoke.sh
eval/daytona-companion/tests/smoke.sh
eval/paseo-companion/tests/smoke.sh
python3 -m unittest discover -s eval/agent-memory/tests -p 'test_*.py'
```

If you want eval runs to use a different Anthropic-compatible endpoint (e.g. an overflow-quota wrapper), point `EVAL_RUNNER` at your own wrapper executable. See [`eval/_shared/README.md`](eval/_shared/README.md) for the layout, the runner contract, and the coverage plan across skills.
