# my-claude-plugins

Personal Claude Code plugin marketplace.

## Skills

The main bundled skills are shipped under a single plugin (`my-skills`).

| Skill | Description |
|-------|-------------|
| [mve-first-development](skills/mve-first-development/) | Shape/Probe/Prove/Protect/Harden stage router for early product delivery; defaults to a real minimum verifiable E2E slice before contract freezing or production hardening |
| [opencode-companion](skills/opencode-companion/) | OpenCode serve/session/job/review runtime via direct companion scripts |
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

- `opencode-orchestrator`: generic orchestration guidance was folded into runtime-specific companion skills; OpenCode runtime commands remain in [opencode-companion](skills/opencode-companion/).
- `task-iteration`, `agentic-orchestration`, `team-lead-orchestration`: generic orchestration guidance was removed from the bundle; plan execution should be handled by the active agent workflow plus the selected runtime adapter.
- `debug-workflow`: browser, documentation, repository, and web-search MCP access should go through [mcp-skill](skills/mcp-skill/) when needed; runtime-specific execution stays in the companion skills.
- `daytona-companion`: removed; Daytona sandbox lifecycle is superseded by `sandbox-ctl` (Cube Sandbox by default, legacy Daytona binding still supported through it).

Companion skills expose direct script entrypoints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" session new --directory "$WORK_DIR" -- "<prompt>"
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
eval/opencode-companion/tests/smoke.sh
eval/paseo-companion/tests/smoke.sh
```

If you want eval runs to use a different Anthropic-compatible endpoint (e.g. an overflow-quota wrapper), point `EVAL_RUNNER` at your own wrapper executable. See [`eval/_shared/README.md`](eval/_shared/README.md) for the layout, the runner contract, and the coverage plan across skills.
