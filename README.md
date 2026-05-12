# my-claude-plugins

Personal Claude Code plugin marketplace.

## Skills

The main bundled skills are shipped under a single plugin (`my-skills`).

| Skill | Description |
|-------|-------------|
| [agentic-orchestration](skills/agentic-orchestration/) | Runtime-neutral principles for lead-agent orchestration, bounded execution lanes, and acceptance gates |
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
| [daytona-companion](skills/daytona-companion/) | Daytona sandbox lifecycle, global project-scoped state, and artifact workflows |
| [paseo-companion](skills/paseo-companion/) | Paseo CLI runtime: agents, terminals, schedules, worktrees, host/port targeting |
| [google-workspace](skills/google-workspace/) | Google Docs/Drive/Sheets via the `gws` CLI |
| [mcp-skill](skills/mcp-skill/) | On-demand MCP server invocation via MCPorter |

### Optional standalone plugins

Some skills are also available as separate opt-in plugins and are not included in the `my-skills` bundle.

| Plugin | Skill | Description |
|--------|-------|-------------|
| `skill-creator` | [skill-creator](skills/skill-creator/) | Vendored fork for creating, evaluating, packaging, and improving Claude Code skills with configurable CLI runners |

Companion skills expose direct script entrypoints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new --directory "$WORK_DIR" -- "<prompt>"
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" status --directory "$WORK_DIR"
```

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

# Smoke tests (offline-safe)
eval/opencode/tests/smoke.sh
eval/daytona/tests/smoke.sh
eval/paseo/tests/smoke.sh
```

If you want eval runs to use a different Anthropic-compatible endpoint (e.g. an overflow-quota wrapper), point `EVAL_RUNNER` at your own wrapper executable. See [`eval/_shared/README.md`](eval/_shared/README.md) for the layout, the runner contract, and the coverage plan across skills.
