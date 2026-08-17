---
name: workspace-org-prac
description: "Reference for organizing an agent workspace at three nested levels: the top-level workspace/volume, a single organization's directory inside it, and a single long-running task bundle. Use when setting up a new workspace or org directory, deciding where a file/repo/task/artifact should live, cleaning up a cluttered directory, designing a task-bundle structure for long-running multi-round work, or reviewing whether an existing layout follows durability/ownership/lifecycle separation."
---

# Workspace Organization Practice

A layered convention for keeping agent-driven work legible as it scales: many
organizations, many long-running tasks, many rounds of delivery, many collaborators. The
convention nests three levels, each documented in `references/`:

| Level | Question it answers | Reference |
|---|---|---|
| Workspace | Whose work is this, and how long does it need to live? | `references/workspace-level.md` |
| Organization | Where do this org's durable assets vs. in-flight tasks go? | `references/org-level.md` |
| Task bundle | Inside one long-running task, which documents still apply? | `references/task-bundle-level.md` |

Read the reference for the level you're working at. They compose: a workspace contains
orgs, an org contains task bundles, a task bundle contains rounds.

## Core idea across all three levels

Structure should let you answer **"is this still current?"** by looking at *where*
something lives, not by reading its contents or trusting a self-declared expiry date.

Concretely, this means separating:
- **durable vs. disposable** — assets meant to outlive any single task vs. scratch work
  meant to be thrown away
- **constraint vs. material** — things that must be followed vs. things that are merely
  useful background, with an explicit rule for what wins on conflict
- **current vs. superseded** — the live entrypoint vs. an append-only historical record

Every level below implements this same idea at a different granularity.

## When to use which reference

- Setting up or reorganizing a whole workspace/volume that will host multiple
  organizations → `workspace-level.md`.
- Deciding where a repo, report, script, or in-flight task belongs inside one
  organization → `org-level.md`.
- A single task has been running for a while, has accumulated many documents from
  multiple rounds, and it's getting hard to tell which ones are current →
  `task-bundle-level.md`.

## Anti-pattern this whole practice exists to prevent

Documents flattened into one directory across many rounds/phases of work, with no
positional signal for staleness. The failure isn't clutter for its own sake — it's that
stale one-off instructions get treated as current requirements because nothing marks them
as expired. Every rule in the three references traces back to preventing this.
