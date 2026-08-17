# Org-Level Organization

This describes how to organize a single organization's directory inside a workspace
(see `workspace-level.md` for the level above this one). An org directory reuses the
workspace's durable-asset framework and adds its own task lifecycle on top.

## Top-level layout

```
orgs/<org>/
├── AGENTS.md / CLAUDE.md   # identity, collaboration conventions, delivery principles
├── code/          # durable code repositories (one subdirectory per repo)
├── knowledge/       # durable org knowledge (analyses, playbooks, exported wiki content)
├── docs/          # published / handoff-ready outputs (reports, audits, runbooks)
├── ops/          # scripts, runbooks, environment and deployment material
├── tasks/         # this org's task lifecycle area (see below)
└── tmp/          # one-off scratch, build leftovers
```

## The four durable asset directories

- **`code/`** — one independent repository per product/service, sitting side by side.
  Typically the largest part of the org directory by file count.
- **`knowledge/`** — durable analysis, playbooks, and topic-organized subfolders. This is
  where conclusions that outlive any single task go.
- **`docs/`** — polished, deliverable artifacts: audit reports, refactor writeups, technical
  reports — generally the final output of some phase of work, meant to be handed off or
  archived as-is.
- **`ops/`** — operational scripts and runbooks: things that are executed or referenced
  repeatedly, not narrative documents.

## The org's task lifecycle: `tasks/`

Where the workspace level has a broad set of lifecycle areas (`active/tasks/research/playground/archive`),
a single org that runs many concurrent, fast-moving tasks benefits from a narrower,
purpose-built lifecycle inside its own `tasks/` directory:

| Subdirectory | Purpose |
|---|---|
| `tasks/active/` | Worktrees, temporary clones, experiments, and investigation sandboxes for current tasks |
| `tasks/archive/` | Completed task workspaces, preserved evidence, logs, material kept for later review |
| `tasks/notes/` | Task prompts, analysis writeups, runbooks, todo lists — short-lived notes that are not durable org documents |

`tmp/` at the org root is one level looser than `tasks/`: it holds purely disposable
output that isn't even expected to be reviewable later, whereas `tasks/archive/` and
`tasks/notes/` are expected to remain legible if someone comes back to them.

## Strong rules

- **Never create ad-hoc task directories at the org root.** Everything task-shaped goes
  into `tasks/active/` first.
- Once a task's output is judged durable, it must be **actively moved out** of `tasks/`
  or `tmp/` into `code/`, `knowledge/`, `docs/`, or `ops/`. Durable material should not
  be left to accumulate inside the task lifecycle area.
- Collaboration conventions (identity, default profiles, credential/key references) belong
  in the org's root `AGENTS.md`/`CLAUDE.md`, not scattered across task documents — anything
  that should apply to every task in the org belongs at that single source of truth.
- A useful delivery framing to pair with this structure: default to the smallest complete
  end-to-end slice for each unit of work, and record real-but-non-blocking findings as
  explicitly deferred work rather than expanding scope mid-task or losing them.

## Organizing logic

An org directory is a tenant inside the workspace: it fully reuses the workspace's
durable-asset framework (`code/knowledge/docs/ops`), but because a single org runs many
tasks concurrently, it grows its own narrower three-stage task lifecycle
(`active → archive`, with a parallel `notes` bucket for short-lived writing) rather than
relying on the workspace's broader, coarser lifecycle areas. In short: **workspace-level
template, plus an org-specific task pipeline layered on top.**
