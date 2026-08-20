# Agent Memory Curation and Capture Design

Agent Memory includes curation and capture policy rather than delegating it to a second
local memory store or a separate skill.

## Responsibilities

- `agent-memory` decides when a failure, correction, drawback, knowledge gap, better recurring approach, or feature request is durable enough to capture.
- `agent-memory capture` resolves the actual project/worktree path, chooses the configured project memory root, writes Markdown, adds canonical tags, links related files, and immediately refreshes the SQLite index.
- Agent Memory search and backlinks make those captures reusable from other CWDs and referenceable from shared/domain knowledge.

## Canonical project/type tags

Captures automatically receive tags such as:

```text
agent-server:learnings
agent-server:drawbacks
agent-server:errors
agent-server:feature-requests
self-improvement:learning
```

The stored/displayed tag remains canonical, but recall is symmetric. `--tag learnings:agent-server`, `--tag agent-server:learnings`, and ordinary search text such as `learnings agent server` all converge on the same memory. Normal search also expands hyphenated tag segments, so `agent server` can recall `agent-server:*` tags.

This makes a repeated `Project × Knowledge Type` structure practical across many projects without requiring the caller to remember hierarchy order.

## Capture layout

Each durable event is a standalone Markdown file rather than an ever-growing `.learnings/LEARNINGS.md` append log:

```text
<project-memory-root>/
  learnings/
    20260820-120000-resolve-real-project-path.md
  drawbacks/
  errors/
  feature-requests/
```

Standalone files give each event its own brief, tags, related-file links, backlinks, and lifecycle. A learning can later link to a canonical workflow/domain document while retaining the original evidence trail.
Capture also writes an explicit frontmatter `type` and uses a concise conclusion plus
`Why` / `How to apply` sections when details and action are supplied. This mirrors the
useful source-document structure of curated memories without requiring a second manual
index file: Agent Memory already supplies scoped FTS, tags, and list/search commands.

## Example

```sh
agent-memory --json capture learning \
  "Resolve the real project path before memory recall" \
  --path /abs/path/to/agent-server \
  --details "A single orchestration CWD can own several sibling projects." \
  --action "Always pass the actual target worktree through --path." \
  --tag memory:routing \
  --related /abs/path/to/agent-server/AGENTS.md
```

If the project has several configured memory roots, the command requires `--root` instead of guessing.
