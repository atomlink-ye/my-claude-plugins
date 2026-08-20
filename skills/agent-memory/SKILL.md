---
name: agent-memory
description: "Use when durable local knowledge may exist outside the current CWD or across multiple projects. Resolve the active project from ~/.agent-memory/settings.json, search the file-first SQLite index, capture durable learnings, open/edit returned Markdown sources, and inspect links/backlinks without copying memory into the current repo."
---

# Agent Memory

Local, file-first memory for agents that may start from one directory while working on
many different projects.

Markdown files are authoritative. SQLite is a disposable registry/index containing paths,
briefs, tags, project visibility, FTS5 search data, and link edges. Never treat a database
row as the canonical memory when the source Markdown is available.

## CLI

Run setup once from the plugin checkout. It links the repository's `agent-memory` bin and
creates an empty settings file only when one does not already exist:

```sh
"${CLAUDE_PLUGIN_ROOT}/skills/agent-memory/scripts/setup.sh"
```

Then use the installed command; pass the actual worktree with `--path` rather than relying
on CWD:

```sh
agent-memory --json status
agent-memory --json resolve --path "$PWD"
agent-memory --json search "learnings agent server" --path "$PWD"
agent-memory --json capture learning "Reusable lesson" --path "$PWD"
agent-memory --json links /abs/path/to/note.md
agent-memory --json sync
```

Before setup, the direct Python script remains an emergency fallback only.

Search first requires every query term. When that has no result, it automatically retries
with OR semantics so a natural-language symptom containing one absent word can still
recall a relevant concise memory. Completely unrelated terms still return no result.

## Scope before recall

For project work, resolve the actual work path before searching. `--path` uses the
nearest/longest nested binding from `~/.agent-memory/settings.json`; sibling projects do
not share their project memory by default.

1. Run `resolve --path <actual project/worktree path>` when project identity is not already explicit.
2. Search with `--path <path>` or `--project <name>`. Project searches include configured shared memory unless `--no-shared` is passed.
3. Use unscoped/global search only when the task explicitly needs cross-project knowledge or the correct project is genuinely unknown.
4. Prefer a returned `brief` to decide relevance, then read the returned absolute `path`.

Do not infer project identity from the process CWD when the actual target path is known.

## Hierarchical tags and symmetric recall

Use `:` to keep a canonical classification path such as:

```text
agent-server:learnings
agent-server:operations:deploy
workflow:review
```

Storage/display remains canonical, but recall does not require hierarchy order:

- `--tag operations` matches `agent-server:operations:deploy`;
- `--tag agent-server:operations` matches it;
- `--tag deploy:agent-server` also matches it because every requested complete segment is present;
- partial strings such as `ops` do not match `operations`.

Normal `search` is tag-aware too. Tag aliases are added only to the disposable FTS index,
not to Markdown metadata. Therefore a document tagged `agent-server:learnings` can be
recalled with either `search "agent server learnings"` or `search "learnings agent server"`.
Hyphenated tag segments also contribute word aliases (`agent-server` -> `agent`, `server`).
Results still show only the full canonical tag.

Multiple explicit `--tag` filters are ANDed. Tags classify knowledge; project visibility
still comes only from settings scopes.

## Write/update loop

When durable knowledge changes, edit the real Markdown source returned by search/list and
keep optional metadata in the small frontmatter subset:

```md
---
title: Agent Team UI Decisions
brief: Durable decisions for the Agent Teams timeline and playback UX.
type: decision
tags: [agent-server:frontend, knowledge:decisions]
---
```

Link related memory with ordinary Markdown links such as
`[Shared review workflow](../../shared/workflows/review.md)`; `[[relative-note]]`
wikilinks are also indexed. Run `sync` after manually creating, moving, deleting, or
materially editing files, and use `links <file>` when backlinks or cross-project
dependencies matter.

## Structured self-improvement capture

`capture` is the write path used by the bundled `self-improvement` skill:

```sh
agent-memory --json capture drawback \
  "Preview routing is coupled to the host configuration" \
  --path /abs/path/to/project \
  --details "The application can be healthy while the preview hostname is unreachable." \
  --action "Validate the host route before changing application code." \
  --tag sandbox:preview \
  --related /abs/path/to/project/docs/sandbox.md
```

Supported kinds are `learning`, `drawback`, `error`, and `feature-request`. Each capture:

- resolves the project from the actual `--path`;
- writes one standalone Markdown file under `learnings/`, `drawbacks/`, `errors/`, or `feature-requests/` inside the project's memory root;
- writes an explicit `type` equal to the capture kind and uses `Why` / `How to apply` sections when details/action are provided;
- adds canonical tags such as `<project>:learnings` and `self-improvement:learning`;
- accepts extra tags and related-file Markdown links;
- runs `sync` immediately so the memory is searchable and backlinkable.

If the resolved project has multiple memory roots, `capture` refuses to guess and requires
`--root` to name one of the configured roots.

The capture policy itself lives in `skills/self-improvement/SKILL.md`. Agent Memory owns
storage, routing, indexing, and references; Self Improvement owns the trigger/curation
policy.

## Settings contract

Default settings are `~/.agent-memory/settings.json`; the SQLite index defaults to
`~/.agent-memory/index.sqlite3`. Override the settings file with `--settings` or
`AGENT_MEMORY_SETTINGS`.

Top-level binding paths must be absolute (or `~`-based). Nested `projects[].path` values
may be relative to their parent. Each `memory` entry can be a path or `{path,tags}`. Child
project memory does **not** inherit parent memory unless `inherit_memory: true` is
explicitly set. Binding tags inherit down the tree; root/frontmatter tags are additive.
All three tag sources support the same `parent:child[:leaf]` hierarchy.

See `docs/agent-memory.md` for the complete settings example, data model, tag behavior,
link behavior, capture workflow, and MVE boundaries.
