# Agent Memory Doctor and Durable Memory Lifecycle

`agent-memory doctor` is the read-only health check for the local registry. YAML remains the default output; `--json`, `--table`, and `--text` are available. Exit codes are `0=healthy`, `1=warnings`, `2=errors`.

## Core diagnostics

Doctor checks routing/binding ambiguity, capture-root configuration, filesystem health, SQLite integrity, stale/unindexed Markdown, dangling local links, tag collisions, and accidental physical-root reuse across project scopes.

The completed roadmap also adds stable-memory diagnostics:

- captured memories receive an opaque `mem_<uuid>` frontmatter `id`;
- duplicate or malformed IDs are errors;
- legacy documents without IDs remain valid and are reported as migration info;
- `memory://mem_xxx` references are checked for missing targets;
- lifecycle values are checked against `raw`, `validated`, `promoted`, `superseded`;
- `promoted` should point to `promoted_to` and `superseded` to `superseded_by`;
- missing lifecycle targets are errors.

Doctor remains read-only and never rewrites Markdown.

## Capture root

A project with several roots can mark exactly one preferred write location:

```json
{"path":"~/workspace/agent-server","project":"agent-server","memory":[{"path":"~/memory/agent-server","capture":true},{"path":"~/memory/research"}]}
```

`--root` remains an explicit override.

## Stable IDs and links

New captures include:

```yaml
---
id: mem_012345...
type: learning
status: raw
tags: [agent-server:learnings]
---
```

The ID is logical identity; the Markdown path remains physical location. Stable cross-project references can therefore use:

```md
[Canonical workflow](memory://mem_012345...)
```

`agent-memory links mem_012345...` resolves stable outbound references and backlinks alongside ordinary Markdown links.

## Lifecycle

```sh
agent-memory lifecycle mem_abc validated
agent-memory lifecycle mem_abc promoted --target mem_canonical
agent-memory lifecycle mem_old superseded --target mem_new
```

Promotion writes `promoted_to: memory://...`; superseding writes `superseded_by: memory://...`. The original Markdown remains as provenance.

## Duplicate-before-capture

Capture performs a lightweight local similarity preflight against existing project Markdown titles/briefs. A likely duplicate is returned without writing a new file:

```sh
agent-memory capture learning "Resolve the actual worktree before recall"
```

The result contains `duplicate_blocked: true` and `possible_duplicates`. If the caller has intentionally decided that separate evidence is warranted, it may explicitly override:

```sh
agent-memory capture learning "..." --allow-duplicate
```

This keeps the decision with the Agent/human instead of silently merging memories.

## Discovery

```sh
agent-memory projects
agent-memory tags --path /abs/path/to/project
agent-memory search "learnings agent server" --path /abs/path/to/project
```

`search`, `list`, and `tags` accept either `--project` or `--path`. If the supplied path
is not covered by a binding, these read-only queries use global scope; `resolve`, `capture`,
and `doctor --path` remain strict and report the unbound path as an error.

Search/list payloads are enriched with stable ID, type, lifecycle state, and promotion/supersession targets when available.
