---
name: mcp-skill
description: Use MCPorter to call MCP servers on demand without keeping MCP servers running in OpenCode.
---

# MCP Skill

Use this skill when you need MCP capabilities such as browser automation,
documentation lookup, repository reading, web search, or remote URL reading.

OpenCode is intentionally configured with no global MCP servers. Heavy MCP
servers must be called on demand through MCPorter so small containers do not
start Playwright, Chrome DevTools, Context7, or Z.AI MCP processes at session
startup.

## Rules

- Use `mcporter` through the shell; do not add servers to `opencode.json`.
- Always pass `--config ~/.mcporter/mcporter.json`.
- Prefer HTTP MCPs (`context7`, `web-search-prime`, `web-reader`, `zread`) over
  local stdio MCPs when they satisfy the task.
- Use local stdio MCPs (`playwright`, `chrome-devtools`, `context7-local`,
  `zai-mcp-server`) only when required.
- Keep calls scoped and short; avoid prewarming or daemon mode in small
  containers.
- Do not print secrets or inspect credential files.

## Common commands

List configured MCP servers:

```bash
mcporter list --config ~/.mcporter/mcporter.json
```

Inspect one MCP server schema:

```bash
mcporter list context7 --schema --config ~/.mcporter/mcporter.json
```

Call Context7 docs:

```bash
mcporter call context7.resolve-library-id libraryName=react --config ~/.mcporter/mcporter.json
mcporter call context7.get-library-docs context7CompatibleLibraryID=/websites/react_dev topic=hooks --config ~/.mcporter/mcporter.json
```

Call Z.AI web search / reader:

```bash
mcporter call web-search-prime.web_search_prime search_query="OpenCode MCP lazy loading" --config ~/.mcporter/mcporter.json
mcporter call web-reader.webReader url=https://example.com --config ~/.mcporter/mcporter.json
```

Call local browser MCP only when necessary:

```bash
mcporter list playwright --schema --config ~/.mcporter/mcporter.json
mcporter call playwright.<tool_name> --args '{"key":"value"}' --config ~/.mcporter/mcporter.json
```

If a tool name is unclear, run `mcporter list <server> --schema` first.
