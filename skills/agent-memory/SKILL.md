---
name: agent-memory
description: "Use when durable local knowledge may exist outside the current CWD or across multiple projects. Resolve the active project from ~/.agent-memory/settings.json, search the file-first SQLite index, open/edit the returned Markdown source, and inspect Markdown links/backlinks without copying memory into the current repo."
---

# Agent Memory

Local, file-first memory for agents that may start from one directory while working on
many different projects.

Markdown files are authoritative. SQLite is a disposable registry/index containing paths,
briefs, tags, project visibility, FTS5 search data, and link edges. Never treat a database
row as the canonical memory when the source Markdown is available.

## CLI

Use the bundled script directly so the workflow does not depend on the current CWD:

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json status
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json resolve --path "$PWD"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json search "query" --path "$PWD"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json links /abs/path/to/note.md
python3 "${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/agent_memory.py" --json sync
```

If the package bin is on `PATH`, `agent-memory ...` is equivalent.

## Scope before recall

For project work, resolve the actual work path before searching. `--path` uses the
nearest/longest nested binding from `~/.agent-memory/settings.json`; sibling projects do
not share their project memory by default.

1. Run `resolve --path <actual project/worktree path>` when project identity is not
   already explicit.
2. Search with `--path <path>` or `--project <name>`. Project searches include configured
   shared memory unless `--no-shared` is passed.
3. Use unscoped/global search only when the task explicitly needs cross-project knowledge
   or the correct project is genuinely unknown.
4. Prefer a returned `brief` to decide relevance, then read the returned absolute `path`.

Do not infer project identity from the process CWD when the actual target path is known.

## Write/update loop

When durable knowledge changes:

1. Edit the real Markdown source at the path returned by search/list.
2. Keep optional metadata in the small frontmatter subset:

```md
---
title: Agent Team UI Decisions
brief: Durable decisions for the Agent Teams timeline and playback UX.
tags: [agent-server, frontend, decisions]
---
```

3. Link related memory with ordinary Markdown links such as
   `[Shared review workflow](../../shared/workflows/review.md)`; `[[relative-note]]`
   wikilinks are also indexed.
4. Run `sync` after creating, moving, deleting, or materially editing memory files.
5. Use `links <file>` when backlinks or cross-project dependencies matter.

The MVE does not auto-extract memories from conversations and does not silently write or
rewrite notes. Capture only when the task/user actually calls for durable memory.

## Settings contract

Default settings are `~/.agent-memory/settings.json`; the SQLite index defaults to
`~/.agent-memory/index.sqlite3`. Override the settings file with `--settings` or
`AGENT_MEMORY_SETTINGS`.

Top-level binding paths must be absolute (or `~`-based). Nested `projects[].path` values
may be relative to their parent. Each `memory` entry can be a path or `{path,tags}`. Child
project memory does **not** inherit parent memory unless `inherit_memory: true` is
explicitly set. Binding tags inherit down the tree; root/frontmatter tags are additive.

See `docs/agent-memory.md` for the complete settings example, data model, link behavior,
and MVE boundaries.
