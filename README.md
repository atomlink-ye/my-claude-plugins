# my-claude-plugins

Personal Claude Code plugin marketplace.

## Companion skills

| Skill | Description |
|-------|-------------|
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
| [daytona-companion](skills/daytona-companion/) | Daytona sandbox lifecycle, global project-scoped state, and artifact workflows |
| [task-iteration](skills/task-iteration/) | Orchestrate feature implementation from exec-plans with Plan→Generate→Evaluate workflow |

`opencode` and `daytona` marketplace entries now exist only as deprecated aliases to the companion skills. The old `/opencode:*` and `/daytona:*` slash-command wrappers have been removed/replaced by direct script calls from skills:

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

Then enable companion skills/plugins:

```json
{
  "enabledPlugins": {
    "opencode-companion@my-claude-plugins": true,
    "daytona-companion@my-claude-plugins": true
  }
}
```

## Development

```bash
pnpm install
pnpm test
```
