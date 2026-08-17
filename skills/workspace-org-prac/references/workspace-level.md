# Workspace-Level Organization

This describes how to organize a top-level agent workspace — the root volume/directory
where one or more organizations' work lives, alongside cross-org scratch space.

Organize by three orthogonal dimensions: **ownership**, **durability**, and **execution mode**.
Ownership answers "whose work is this" (which org). Durability and execution mode together
answer "how long does this need to live, and what stage of work produced it."

## Top-level layout

```
workspace/
├── orgs/         # one subdirectory per organization/tenant — durable, org-owned assets
├── active/        # lifecycle-driven work in progress, not yet tied to one org's task area
├── tasks/        # standalone named task bundles that need a stable sandbox
│           # outside the active/ lifecycle tree
├── research/       # topic investigations that aren't scoped to one org
├── playground/      # prototypes and experiments
├── archive/       # stale-but-keepable material
├── tmp/         # short-lived scratch work
└── system/        # workspace-level infra config (not project content)
```

## Placement rules

| Content type | Location |
|---|---|
| Long-lived code | `orgs/<org>/code/` (see org-level doc) |
| Durable notes, domain maps, ADRs | `orgs/<org>/knowledge/` |
| Polished/handoff outputs | `orgs/<org>/docs/` |
| Scripts, environment/setup material | `orgs/<org>/ops/` |
| Lifecycle-driven temporary work | `active/` |
| A standalone task needing a fixed sandbox outside the active/ lifecycle | `tasks/` |
| Topic investigation not owned by one org | `research/` |
| Prototypes / experiments | `playground/` |
| Stale but worth keeping | `archive/` |
| Disposable scratch | `tmp/` |

## Strong rules

- **Never create a new durable repo at the workspace root.** Durable code only lives under
  `orgs/<org>/code/`.
- `active/archive/` (a sub-area of `active/`) is only for recently completed bundles that
  still need to stay close to in-progress work. Once a bundle stops being actively
  referenced, either move it to the top-level `archive/`, or promote genuinely durable
  outputs into `orgs/*`, `research/`, or `playground/`.
- Keep **one canonical home per repo**. Duplicate working copies belong in an `archive/duplicates/`
  area or inside an active task sandbox — never scattered across multiple locations.
- Infrastructure-managed hidden directories (OS metadata, package-manager caches, filesystem
  event stores) should be left alone unless explicitly asked to touch them — they are not
  part of the organizational scheme.

## Organizing logic

The structure answers two questions in sequence:

1. **Whose work is this?** → `orgs/<org>/` if it belongs to a specific organization;
   otherwise one of the cross-org lifecycle areas.
2. **How long does it need to live, and what stage produced it?** → durable assets
   (`code/knowledge/docs/ops`) vs. a lifecycle chain from "in progress" to "should be
   discarded" (`active → tasks/research/playground → archive → tmp`).

Work starts in a lifecycle area. If its output proves durable, it gets promoted into one
of the four durable categories inside the owning org. If not, it eventually flows into
`archive/` or gets cleaned out of `tmp/`.
