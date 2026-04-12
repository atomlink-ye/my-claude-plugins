# my-claude-plugins

Personal Claude Code plugin marketplace. Contains reusable plugins, tools, and skills that extend Claude Code's capabilities.

## Repository structure

```
├── plugins/          # Plugin manifests and configurations
├── skills/           # Skill definitions (loaded by Claude Code)
├── tools/            # Tool implementations (source code only, no tests)
│   └── agent-wallet/ # Agent Wallet Bridge — EIP-1193 provider injection for Web3
├── eval/             # Tests and evaluations for all tools/plugins
│   ├── agent-wallet/ # Tests for agent-wallet
│   └── opencode/     # Tests for opencode
└── .claude-plugin/   # Plugin marketplace manifest
```

## Guidelines

### Tests and evaluations live under `./eval`, not alongside source

All tests, e2e scripts, and evaluation harnesses for every tool or plugin go in `./eval/<tool-name>/`. Source artifacts under `tools/` and `skills/` must not contain test files.

This repo is loaded by other users as a plugin marketplace. Shipping tests inside the artifacts would be confusing and add unnecessary weight. Keep `tools/` clean — only production source code.

### Running tests

```bash
# From a tool directory (e.g. tools/agent-wallet)
pnpm test

# Or from the repo root
pnpm test
```

### Adding a new tool

1. Create source under `tools/<name>/`
2. Create tests under `eval/<name>/tests/`
3. Point the tool's `vitest.config.ts` (if any) to `../../eval/<name>/tests/`
