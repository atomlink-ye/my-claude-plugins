---
name: agent-memory
description: "TRIGGER — before non-trivial work or ‘have we seen this?’ questions, recall; before reporting a durable event, capture user corrections (‘no’, ‘actually’, ‘其实’), reusable bug fixes, drawbacks, proven better practices, or feature requests. Use doctor when memory routing/index/link health is uncertain. SKIP only typos/transient failures, secrets, raw transcripts, or expiring trivia."
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

Agent Memory emits deterministic, stdlib-only YAML by default. Use exactly one of the
global output flags when another representation is needed: `--json` for scripts and
backward-compatible machine output, `--table` for compact collection/health tables, or
`--text` for the legacy human-readable view. The flags are mutually exclusive and apply
to every subcommand, including `init` and `doctor`.

```sh
agent-memory --json status
agent-memory --json doctor --path "$PWD"
agent-memory --json resolve --path "$PWD"
agent-memory --json projects
agent-memory --json tags --path "$PWD"
agent-memory --json search "learnings agent server" --path "$PWD"
agent-memory --json capture learning "Reusable lesson" --path "$PWD"
agent-memory --json links /abs/path/to/note.md
agent-memory --json sync
agent-memory --json snapshot
agent-memory --json snapshot inspect /abs/path/to/agent-memory-20260820T120000Z.tar.gz
```

Before setup, the direct Python script remains an emergency fallback only.

Search first requires every query term. When that has no result, it automatically retries
with OR semantics so a natural-language symptom containing one absent word can still
recall a relevant concise memory. Completely unrelated terms still return no result.

## Health and discovery before recall

Use `doctor` when setup may be stale, a link looks broken, capture routing is unclear, or
an Agent has inherited an unfamiliar machine/workspace. It is read-only.

`doctor` checks:

- project binding duplication/ambiguity and reused project names;
- missing/unreadable memory roots and writable capture/database locations;
- ambiguous or duplicate `capture: true` roots;
- SQLite `PRAGMA quick_check`;
- indexed files that disappeared or changed since the last sync;
- Markdown under configured roots that is not indexed yet;
- dangling local Markdown links (including targets deleted after sync) versus existing local
  files outside the memory graph;
- deterministic tag case/separator collisions;
- physical memory roots reused by multiple project scopes.

`doctor --path <actual-worktree>` also reports the resolved project, binding, memory roots,
and default capture root. Exit codes are `0=ok`, `1=warnings`, `2=errors`.

Use discovery before guessing taxonomy:

```sh
agent-memory projects
agent-memory tags --path /abs/path/to/project
```

`projects` reports configured project paths, roots, capture roots, and indexed document
counts. `tags` reports canonical tags and usage counts and can be scoped with `--path` or
`--project`.

## Snapshot before destructive bulk work

Before a bulk Markdown edit without another rollback mechanism, create one portable,
read-only archive of the configured memory sources and index:

```sh
agent-memory --json snapshot
agent-memory --json snapshot --output /abs/path/to/backup-directory
agent-memory --json snapshot search /abs/path/to/agent-memory-20260820T120000Z.tar.gz "sandbox ownership"
agent-memory --json snapshot inspect /abs/path/to/agent-memory-20260820T120000Z.tar.gz
```

The default destination is `snapshots/` beside the active settings file. The archive keeps
`settings.json`, a consistent SQLite copy, any present SQLite WAL/SHM sidecars, and every
Markdown file under each configured root. `manifest.json` maps each archive root back to
its original absolute path and scope, so unrelated roots are never flattened together.
Missing or unreadable roots are skipped and returned in the result; sources and settings
are never changed and snapshot does not run `sync`.

`snapshot search ARCHIVE QUERY` opens only the archived SQLite index in a temporary
directory and returns matching memories without touching the live registry. `snapshot
inspect ARCHIVE` reads only the manifest and reports the archived projects and memory roots.
Temporary extraction is removed at command exit.

Agent Memory deliberately provides no automatic restore command. To recover, manually
extract the archive, inspect `manifest.json`, and decide yourself how to handle existing
files before copying any source back.

Use an external cron/launchd scheduler when periodic snapshots are wanted. Agent Memory
only performs one archive operation per invocation.

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

## Capture policy

Agent Memory owns both recall and the judgment to capture durable, curated knowledge. Do
not create a separate project-local `.learnings/` database or assume the current CWD owns
the learning. Agent Memory resolves the actual project, writes Markdown into that
project's configured memory root, and indexes it for later cross-CWD recall and linking.

### Capture when the signal is durable

Capture one concise memory when any of these materially changes how future work should be
done:

- the user corrects an incorrect assumption or result → `learning`
- a better recurring approach is discovered → `learning`
- an architectural/tool/workflow drawback becomes clear → `drawback`
- a command, integration, API, or runtime fails in a reusable way → `error`
- the user requests a missing reusable capability → `feature-request`

Do not capture routine transient failures, secrets, raw transcripts, noisy debugging
output, or facts that will obviously expire immediately.

### Write through `agent-memory capture`

Pass the actual project/worktree path rather than trusting the process CWD:

```sh
agent-memory --json capture drawback \
  "Preview routing is coupled to the host configuration" \
  --path /abs/path/to/project \
  --details "The application can be healthy while the preview hostname is unreachable." \
  --action "Validate the host route before changing application code." \
  --tag sandbox:preview \
  --related /abs/path/to/project/docs/sandbox.md
```

Kinds are `learning`, `drawback`, `error`, and `feature-request`. Each capture:

- resolves the project from the actual `--path`;
- writes one standalone Markdown file under `learnings/`, `drawbacks/`, `errors/`, or `feature-requests/` inside the project's memory root;
- writes an explicit `type` equal to the capture kind and uses `Why` / `How to apply` sections when details/action are provided;
- adds canonical tags such as `<project>:learnings` and `self-improvement:learning`;
- accepts extra tags and related-file Markdown links;
- runs `sync` immediately so the memory is searchable and backlinkable.

When a project has multiple memory roots, mark exactly one root as the default capture
location:

```json
{
  "memory": [
    {"path": "~/memory/agent-server", "capture": true, "tags": ["agent-server:knowledge"]},
    {"path": "~/memory/shared-research", "tags": ["research"]}
  ]
}
```

If only one root exists it remains the implicit default. `--root` is an explicit override.
If multiple roots exist without `capture: true`, capture refuses to guess and `doctor`
reports `capture_root_ambiguous`.

## Recall before repeating work

Normal Agent Memory search is tag-aware. These all intentionally converge on the same
canonical project learning:

```sh
agent-memory search "learnings agent server" --path /abs/path/to/agent-server
agent-memory list --path /abs/path/to/agent-server --tag learnings
agent-memory list --path /abs/path/to/agent-server --tag learnings:agent-server
```

A stored tag such as `agent-server:learnings` is displayed in full even when the query is
reversed or uses only the `learnings` segment. Tag order is a classification convention,
not a recall requirement.

## Promote instead of duplicating

A captured learning starts as evidence, not automatically as a global rule. When it is
repeatedly useful:

1. keep the original learning Markdown as provenance;
2. update the canonical workflow/domain/architecture document that should own the rule;
3. link the learning to that document with a normal Markdown link;
4. use `agent-memory links` to retain the backlink trail.

This lets multiple projects cite shared domain knowledge without flattening their project
memory scopes.

## Settings contract

Default settings are `~/.agent-memory/settings.json`; the SQLite index defaults beside the
settings file as `index.sqlite3`. Override the settings file with `--settings` or
`AGENT_MEMORY_SETTINGS`.

Top-level binding paths must be absolute (or `~`-based). Nested `projects[].path` values
may be relative to their parent. Each `memory` entry can be a path or `{path,tags,capture}`.
Child project memory does **not** inherit parent memory unless `inherit_memory: true` is
explicitly set. Binding tags inherit down the tree; root/frontmatter tags are additive.
All three tag sources support the same `parent:child[:leaf]` hierarchy.

See `docs/agent-memory.md` for the complete settings example, data model, tag behavior,
link behavior, capture workflow, and MVE boundaries.
