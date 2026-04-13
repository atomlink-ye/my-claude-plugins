# my-claude-plugins

Personal Claude Code plugin marketplace.

## Plugins

| Plugin | Description |
|--------|-------------|
| [opencode](plugins/opencode/) | Delegate AI coding tasks to OpenCode via its serve API |
| [task-iteration](skills/task-iteration/) | Orchestrate feature implementation from exec-plans with Plan→Generate→Evaluate workflow |

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

Then enable plugins:

```json
{
  "enabledPlugins": {
    "opencode@my-claude-plugins": true
  }
}
```

## Development

```bash
pnpm install
pnpm test
```
