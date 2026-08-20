---
name: self-improvement
description: "Capture durable learnings, drawbacks, errors, corrections, missing capabilities, and recurring better practices through the local Agent Memory registry. Use after a meaningful failure, user correction, discovered drawback, knowledge gap, repeated workflow improvement, or feature request; also recall prior learnings before repeating similar work."
---

# Self Improvement through Agent Memory

This skill is the capture policy on top of `agent-memory`. Do not create a separate
project-local `.learnings/` database or assume the current CWD owns the learning.
Agent Memory resolves the actual project, writes Markdown into that project's configured
memory root, and indexes it for later cross-CWD recall and linking.

## Capture when the signal is durable

Capture one concise memory when any of these materially changes how future work should be
done:

- the user corrects an incorrect assumption or result → `learning`
- a better recurring approach is discovered → `learning`
- an architectural/tool/workflow drawback becomes clear → `drawback`
- a command, integration, API, or runtime fails in a reusable way → `error`
- the user requests a missing reusable capability → `feature-request`

Do not capture routine transient failures, secrets, raw transcripts, noisy debugging
output, or facts that will obviously expire immediately.

## Write through `agent-memory capture`

Pass the actual project/worktree path rather than trusting the process CWD:

```sh
agent-memory --json capture learning \
  "Cube preview URLs require explicit host routing" \
  --path /abs/path/to/project \
  --details "The sandbox itself was healthy; the failure was the host-side route." \
  --action "Check the configured preview host before debugging the app." \
  --tag sandbox:preview \
  --related /abs/path/to/project/docs/sandbox.md
```

Kinds are:

```text
learning | drawback | error | feature-request
```

The command writes one Markdown file under the chosen memory root and immediately syncs
the SQLite index. It automatically adds canonical tags such as:

```text
<project>:learnings
<project>:drawbacks
<project>:errors
<project>:feature-requests
self-improvement:<kind>
```

Additional `--tag` values are additive. If the project has multiple memory roots, pass
`--root` explicitly rather than guessing.

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
