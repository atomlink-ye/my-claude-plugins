# my-claude-plugins

Personal Claude Code plugin marketplace.

## Skills

All skills are bundled under a single plugin (`my-skills`).

| Skill | Description |
|-------|-------------|
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
| [daytona-companion](skills/daytona-companion/) | Daytona sandbox lifecycle, global project-scoped state, and artifact workflows |
| [paseo-companion](skills/paseo-companion/) | Paseo CLI runtime: agents, terminals, schedules, worktrees, host/port targeting |
| [task-iteration](skills/task-iteration/) | Orchestrate feature implementation from exec-plans with Plan→Generate→Evaluate workflow |
| [opencode-orchestrator](skills/opencode-orchestrator/) | Routing rules for delegating to OpenCode vs. handling work locally |
| [debug-workflow](skills/debug-workflow/) | Real-world issue reproduction (browser/UI/Web3) with Playwright/CDP/agent-wallet |
| [google-workspace](skills/google-workspace/) | Google Docs/Drive/Sheets via the `gws` CLI |
| [mcp-skill](skills/mcp-skill/) | On-demand MCP server invocation via MCPorter |

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

## Development

```bash
pnpm install
pnpm test
```
