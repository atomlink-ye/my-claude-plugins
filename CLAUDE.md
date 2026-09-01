# my-claude-plugins

Personal Claude Code plugin marketplace. Contains reusable plugins, tools, and skills that extend Claude Code's capabilities.

## Repository structure

```
├── plugins/          # Plugin manifests and configurations
├── skills/           # Skill definitions (loaded by Claude Code)
│   └── agent-runtime-control-panel/runtime/ # Deliberate daemon-source exception; ships with its skill
├── tools/            # Tool implementations (source code only, no tests)
│   └── agent-wallet/ # Agent Wallet Bridge — EIP-1193 provider injection for Web3
├── eval/             # Tests and evaluations for all tools/plugins
│   ├── agent-wallet/ # Tests for agent-wallet
│   └── opencode/     # Tests for opencode
└── .claude-plugin/   # Plugin marketplace manifest
```

## Guidelines

### Tests and evaluations live under `./eval`, not alongside source

All tests, e2e scripts, and evaluation harnesses for every tool, plugin, or skill go in `./eval/<name>/`. Evaluation definitions, source inputs, fixtures, and metadata go in the matching `./eval/<name>/evals/` directory. Source artifacts under `tools/` and `skills/` must not contain test or evaluation files.

This repo is loaded by other users as a plugin marketplace. Shipping tests or evals inside the artifacts would be confusing and add unnecessary weight. Keep `tools/` and `skills/` clean — only production source code and runtime skill assets.

`skills/agent-runtime-control-panel/runtime/` is a deliberate exception to the
usual source placement rule: the ARCP daemon ships inside its owning skill so
discovery and bootstrap remain self-contained. Its tests live under
`eval/agent-runtime-control-panel/`. This is not a precedent for placing
unrelated tool implementations under `skills/`.

Evaluation run results, logs, transcripts, and generated outputs should not be committed under `./eval`. Keep only the original eval inputs and metadata needed to rerun the evaluation.

### Planning and working notes are not repository docs

Do not commit implementation plans, design drafts, independent reviews, agent transcripts, status logs, or other working notes under `./docs`. This marketplace is installed by other users, so `docs/` should not accumulate transient planning records from local agent work.

Keep working notes outside the repository, or in a local ignored scratch area. Only commit documentation that is intended to ship as durable user-facing or maintainer-facing reference material. Reproducible eval inputs still belong under `./eval/<name>/evals/`; eval run outputs and generated reports should remain uncommitted.

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
3. Create evaluation inputs and metadata under `eval/<name>/evals/`
4. Point the tool's `vitest.config.ts` (if any) to `../../eval/<name>/tests/`
