# Agent Memory Doctor

`agent-memory doctor` is the read-only health check for the local Agent Memory registry.
It is intended for both humans and Agents that need to answer: is routing safe, is capture
configured, is the derived index current, and are local references healthy?

## Commands

```sh
agent-memory doctor
agent-memory --json doctor
agent-memory doctor --path /abs/path/to/project
```

`--path` additionally resolves the actual worktree and reports its project, binding,
memory roots, and default capture root.

Exit codes:

```text
0  healthy
1  warnings only
2  errors / unsafe configuration
```

The first implementation is deliberately read-only; there is no `--fix`.

## Checks

Doctor currently checks:

- duplicate resolved binding paths and reused project names;
- projects with no memory roots;
- multiple roots without a `capture: true` default;
- multiple roots incorrectly marked `capture: true`;
- missing, non-directory, or unreadable memory roots;
- writability of capture roots and the SQLite parent directory;
- physical memory roots visible in multiple project scopes;
- SQLite `PRAGMA quick_check`;
- indexed files that disappeared;
- indexed files whose mtime/size changed since the last sync;
- Markdown files under configured roots that are not indexed;
- local links whose targets are missing (including targets deleted after the last sync),
  distinguishing them from existing local files outside the indexed memory graph;
- deterministic tag case and hyphen/underscore collisions.

Warnings about stale/unindexed files recommend `agent-memory sync`; Doctor does not run it
automatically.

## Capture root

When a project has several memory roots, configure one preferred write location:

```json
{
  "path": "~/workspace/agent-server",
  "project": "agent-server",
  "memory": [
    {
      "path": "~/memory/agent-server",
      "capture": true,
      "tags": ["agent-server:knowledge"]
    },
    {
      "path": "~/memory/research",
      "tags": ["research"]
    }
  ]
}
```

A single memory root remains an implicit capture root. With multiple roots and no marked
default, capture refuses to guess and Doctor reports `capture_root_ambiguous`. `--root`
remains an explicit override.

## JSON contract

Example:

```json
{
  "status": "warn",
  "summary": {
    "errors": 0,
    "warnings": 2,
    "info": 1,
    "bindings": 4,
    "documents": 83,
    "dangling_links": 1,
    "unindexed_markdown": 1,
    "stale_documents": 0
  },
  "resolved": {
    "path": "/workspace/agent-server",
    "project": "agent-server",
    "binding": "/workspace/agent-server",
    "memory_roots": ["/memory/agent-server"],
    "capture_root": "/memory/agent-server"
  },
  "checks": [
    {
      "code": "link_target_missing",
      "severity": "warning",
      "message": "local Markdown link target does not exist",
      "paths": ["/memory/shared/old-workflow.md"]
    }
  ]
}
```

Finding `code` values are stable machine-readable identifiers; Agents should prefer them
over parsing the prose message.

## Discovery

Two companion discovery commands make the registry observable before search:

```sh
agent-memory projects
agent-memory tags
agent-memory tags --path /abs/path/to/project
agent-memory tags --project agent-server
```

`projects` reports binding paths, memory roots, default capture roots, binding tags, and
indexed document counts. `tags` reports canonical tags and document counts; project-scoped
tag discovery includes shared memory by default and accepts `--no-shared`.

## Follow-up checks

Stable memory IDs and `memory://` references are intentionally deferred. Once those land,
Doctor should add duplicate/missing ID checks and broken stable-reference checks. Promotion
lifecycle checks (`promoted_to`, `superseded_by`) should be added at the same time rather
than inventing a second identity mechanism now.
