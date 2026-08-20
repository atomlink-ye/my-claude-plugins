# Local Agent Memory Registry

## Problem

Coding agents are often launched from a workspace, task bundle, or orchestration root
that is not the repository they are currently working on. A single launch directory may
control several unrelated projects. CWD-scoped memory (`CLAUDE.md`, `.memory/`, or a
project-local self-improvement skill) therefore creates two failure modes:

1. **missed memory** — useful durable knowledge lives in another project or domain folder;
2. **cross-project leakage** — an agent launched above projects A and B accidentally uses
   A's memory while working on B.

The desired system is not a conversation-memory engine. It is a small local registry that
answers: *which durable files are relevant, where are they, and how are they related?*

## MVE goals

- Markdown files remain the source of truth and stay directly editable by humans/agents.
- One local SQLite database indexes paths, titles, briefs, tags, scopes, full text, and
  link relationships.
- Project identity is resolved from an explicit local settings file, not inferred from the
  agent process CWD.
- Nested project mappings support a workspace that contains many projects with different
  memory roots.
- The most-specific (longest path prefix) mapping wins.
- Child projects do not inherit parent memory unless `inherit_memory: true` is explicit.
- Shared/domain memory can be visible to every project without merging project-specific
  scopes.
- Tags can be hierarchical (`parent:child[:leaf]`) while remaining searchable by any
  complete subtag/segment such as `child`; results preserve the full canonical tag.
- Standard Markdown links create a local graph; outbound links and inbound backlinks can
  cross project boundaries.
- The CLI returns compact briefs and absolute file paths first; agents open the actual file
  only when needed.
- Search uses SQLite FTS5/BM25. No embedding service, vector DB, daemon, cloud account, or
  LLM extraction is required.

## Non-goals for this MVE

- Automatically learning from every chat/session.
- Replacing Claude Code/Codex/OpenCode session memory.
- Semantic/vector search.
- Background filesystem watchers.
- Conflict resolution or multi-device sync.
- A graph database or transitive graph reasoning.
- Automatic consolidation, decay, scoring, or self-improvement policies.
- MCP as the primary transport. The CLI is the stable core; MCP can be an adapter later.

## Local layout

```text
~/.agent-memory/
  settings.json        # authoritative path/scope configuration
  index.sqlite3        # disposable derived index

~/memory/
  shared/
    workflows/
      review.md
  agent-server/
    architecture.md
    ui-decisions.md
  other-project/
    decisions.md
```

The Markdown files do not need to live under `~/.agent-memory/`; they may live anywhere
on the local filesystem. The settings file only records where to find them.

## Settings

Default path: `~/.agent-memory/settings.json`.

```json
{
  "version": 1,
  "database": "~/.agent-memory/index.sqlite3",
  "shared": [
    {
      "path": "~/memory/shared",
      "tags": ["shared:domain"]
    }
  ],
  "bindings": [
    {
      "path": "~/workspace",
      "project": "workspace",
      "memory": ["~/memory/workspace"],
      "tags": ["workspace"],
      "projects": [
        {
          "path": "agent-server",
          "project": "agent-server",
          "memory": [
            {
              "path": "~/memory/agent-server",
              "tags": ["agent-server:knowledge", "knowledge:decisions"]
            }
          ],
          "tags": ["agent-server"]
        },
        {
          "path": "experiments/ui-a",
          "project": "ui-a",
          "memory": ["~/memory/ui-a"],
          "tags": ["prototype:ui"]
        },
        {
          "path": "experiments/ui-b",
          "project": "ui-b",
          "memory": ["~/memory/ui-b"],
          "tags": ["prototype:ui"]
        }
      ]
    }
  ]
}
```

### Path resolution rules

- A top-level `bindings[].path` must be absolute after `~` / environment expansion. This
  keeps configuration independent from the process CWD.
- A nested `projects[].path` may be relative to its parent binding.
- A relative `memory` entry is resolved against that binding's resolved project path.
- A `memory` entry may be a path string or `{ "path": "...", "tags": [...] }`; root tags are merged with binding and Markdown tags.
- When several bindings contain the target path, the longest/more-specific path wins.
- Two equally specific bindings are an error instead of an arbitrary choice.
- `memory` roots from the parent are **not** inherited by a child by default. Set
  `"inherit_memory": true` on the child to opt in.
- Binding tags are inherited by children. Tags classify documents; they do not grant
  project visibility.
- `shared` roots are indexed under the reserved `_shared` scope. A project-scoped query
  includes `_shared` unless `--no-shared` is requested.

This makes the common multi-project workspace safe by default:

```text
~/workspace/project-a/...  -> project-a memory + shared memory
~/workspace/project-b/...  -> project-b memory + shared memory
```

Project A and B do not see each other's project memory simply because the agent was
launched from `~/workspace`.

## Hierarchical tags

Tags from bindings, memory roots, and Markdown frontmatter all support a colon-delimited
hierarchy:

```text
agent-server:operations
agent-server:architecture
agent-server:operations:deploy
workflow:review
```

The stored value is always the full canonical tag. Whitespace around hierarchy separators
is normalized, so `agent-server : operations` becomes `agent-server:operations` during
indexing/config resolution. Empty hierarchy segments such as `agent-server::operations`
are rejected.

Tag filtering works on complete colon-delimited segments/subpaths, case-insensitively:

```text
stored tag: agent-server:operations:deploy

--tag operations                 -> match
--tag deploy                     -> match
--tag agent-server:operations    -> match
--tag OPERATIONS                 -> match
--tag ops                        -> no match
```

The important display rule is that a subtag is a **lookup alias, not a second stored tag**.
A query by `--tag operations` still returns:

```json
{
  "tags": ["agent-server:operations:deploy"]
}
```

It does not return or persist an extra flat `operations` tag. This preserves the context
that the operations knowledge belongs under `agent-server`.

When several `--tag` arguments are supplied, they are ANDed. For example,
`--tag operations --tag runbook` requires a document to have a canonical tag containing
`operations` and another (or the same hierarchical tag) containing `runbook` as complete
segments.

Hierarchical tags are classification only. They do not change project scope, shared
visibility, or the longest-prefix binding rules.

## Markdown memory format

Any `.md` file under a configured memory root is indexed. Frontmatter is optional. The MVE
supports `title`, `brief`, `type`, and `tags` in a deliberately small YAML-like subset:

```md
---
title: Agent Team Operations
brief: Durable operating knowledge for Agent Teams deployment and maintenance.
type: reference
tags: [agent-server:operations, knowledge:runbook]
---

# Agent Team Operations

...
```

If `title` is absent, the first H1 (or filename) is used. If `brief` is absent, the first
non-heading paragraph is used. Tags from settings and frontmatter are merged and kept in
canonical hierarchical form.

`type` is an explicit source-level classification (for example `learning`, `error`,
`feedback`, or `reference`). It remains deliberately separate from project scope and tags;
the MVE preserves it in Markdown rather than adding another filter surface prematurely.

Project scope is controlled by settings rather than file frontmatter. A note cannot place
itself into another project's search scope by declaring a metadata field.

## References and backlinks

The index extracts ordinary local Markdown links:

```md
See the [shared review workflow](../../shared/workflows/review.md).
```

It also accepts simple relative wikilinks:

```md
See [[architecture-decisions]].
```

HTTP(S), mail, and other external schemes are not added to the local graph. Local links
are normalized to absolute paths in the derived index while the Markdown source remains
unchanged.

After `sync`, every edge records:

```text
source document
  -> original href / label / optional anchor
  -> normalized target path
  -> resolved target document id (when indexed)
```

`agent-memory links <document>` returns both:

- `outbound`: documents referenced by the source, including dangling local targets;
- `inbound`: indexed documents that reference the source (backlinks).

Because identity is the normalized source file path, a project-specific note can link to a
shared domain note, or one project can explicitly reference another project's durable
knowledge, without globally merging their search scopes.

## SQLite model

SQLite is rebuildable derived state:

```text
documents
  id, path, title, brief, mtime_ns, size, sha256

document_scopes
  document_id, scope

document_tags
  document_id, tag          # full canonical hierarchy only

document_fts (FTS5)
  rowid -> title, brief, content

links
  source_document_id
  target_path
  target_document_id?   # null when dangling/not indexed
  href, label, anchor
```

Subtag lookup does not need duplicate rows or a second alias table in the MVE. Filtering
matches complete `:`-delimited segments against the canonical value in `document_tags`.

The same physical document can have multiple scopes when a memory root is intentionally
reused or inherited. This is represented in `document_scopes` rather than duplicating the
file.

## CLI

The implementation is stdlib-only Python 3 plus SQLite/FTS5.

```sh
# bootstrap
agent-memory init

# verify paths / counts
agent-memory --json status
agent-memory --json resolve --path ~/workspace/agent-server

# rebuild the derived registry after source changes
agent-memory --json sync

# project-safe recall; shared memory is included
agent-memory --json search "sandbox filesystem" --path ~/workspace/agent-server
agent-memory --json search "deployment" --project agent-server --tag operations
agent-memory --json search "deployment" --project agent-server --tag agent-server:operations
agent-memory --json list --path ~/workspace/agent-server --tag architecture

# deliberately global/cross-project recall
agent-memory --json search "review workflow"

# graph inspection
agent-memory --json links ~/memory/agent-server/ui-decisions.md
```

The global `--settings PATH` option supports alternate registries and tests. The
`AGENT_MEMORY_SETTINGS` environment variable can set the same default.

## Agent workflow

The intended progressive-disclosure loop is:

```text
actual work path
  -> resolve project
  -> scoped search/list (+ optional hierarchical tag filters)
  -> brief + absolute source path + canonical full tags
  -> open/read the Markdown file
  -> act
  -> edit/create/delete Markdown only when durable knowledge changes
  -> sync
  -> inspect links/backlinks when dependencies matter
```

The skill should normally pass the actual project/worktree path, not merely `$PWD`, when
those differ.

## Reference projects

The implementation borrows design ideas, not source code, from:

- **Basic Memory** (`basicmachines-co/basic-memory`, AGPL-3.0): Markdown as durable source
  of truth, local-first indexing, project-aware memory, and wiki-link knowledge graph.
- **mnemos** (`arhuman/mnemos`, MIT): SQLite FTS5/BM25, cited file-oriented retrieval,
  absolute configuration anchoring, and explicit outbound/inbound link inspection.
- **Mooncite / claude-memory-mcp** (`WhenMoon-afk/claude-memory-mcp`): evidence-first
  principle that an index/locator should point back to inspectable physical source bytes.

No code is copied from those projects. This MVE intentionally stays smaller: Python
stdlib + SQLite + Markdown + one CLI/Skill contract.

## Follow-up features (not required for this PR)

1. `project add/remove` commands that edit `settings.json` safely instead of requiring
   manual JSON edits.
2. Incremental sync using stored hashes/mtimes and an optional watcher.
3. Stable `memory://...` identifiers/aliases for links that should survive file moves.
4. Heading/chunk-level indexing and line-range citations.
5. Optional semantic/hybrid search behind a local-only extra.
6. Optional MCP adapter exposing the same `resolve/search/list/links/sync` contract.
7. A conservative capture/consolidation workflow once manual file-first memory proves
   useful in daily multi-agent work.
