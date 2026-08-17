# Task-Bundle-Level Organization

This describes how to organize a single long-running task bundle — a task directory that
stays active for weeks, spans multiple delivery rounds, and involves multiple
collaborators or sub-agents. A plain flat folder stops working at this scale: documents
pile up and it quickly becomes unclear which ones still apply.

## The core problem

An unstructured task folder degrades into "dozens of documents flat in the root,
spanning many rounds of work." The failure mode isn't clutter — it's that **stale,
one-off instructions get treated as current requirements**, even though the task has long
since moved past them.

The fix isn't "clean up more often." It's making **whether a document still applies a
fact expressed by its location**, instead of relying on every document to declare its own
expiry.

## Directory layout

```
<task-bundle>/
├── README.md      # index: what lives where, what order to read it in
├── CONTEXT.md      # entrypoint: current status, points at the active round
├── CHANGELOG.md     # reverse-chronological delivery history
├── DEFERRED.md      # backlog of explicitly deferred work (writing it here = decided not to do it now)
├── authority/      # cross-round constraints that must be followed
├── reference/      # cross-round background material, optional reading
├── rounds/        # one directory per delivery round: briefs, plans, workflow, evidence
├── history/        # superseded handoffs, append-only
├── reports/        # acceptance reports for completed sub-tasks / sub-teams
├── dispatch/       # lightweight dispatch briefs that didn't spawn a full round directory
└── tmp/          # everything disposable: sandbox bindings, repo copies, probes, one-off scripts
```

## Root holds only three "live" files

The bundle root should not accumulate historical documents. It holds exactly three files
that always represent current state:

| File | Purpose | When to read it |
|---|---|---|
| `CONTEXT.md` | Entrypoint, points at the current round | Before picking up any work |
| `CHANGELOG.md` | Reverse-chronological delivery history | When you need to know when something landed |
| `DEFERRED.md` | Backlog of deferred work | When deciding to cut something from scope |

Dispatch briefs, plans, workflow drafts, and handoffs do **not** belong in the root — they
go into `rounds/<current-round>/`.

## `authority/` vs `reference/`: a substantive distinction, not a style choice

This is the pair of directories most likely to be misused, so the distinction has to be
stated explicitly:

| | `authority/` | `reference/` |
|---|---|---|
| Nature | **Constraint** — must be followed | **Material** — optional reading |
| On conflict with another document | It wins; the other document gets corrected | It yields |
| Who must read it | Every sub-task, before starting | Only when background is needed |

`authority/` typically holds:
- A running log of global decisions (a single living document with appended, numbered
  entries — don't start a new file for each new decision)
- Shared cross-round workflow/dispatch templates (each round only fills in the
  round-specific parts)

`reference/` typically holds: design drafts, roadmaps, research writeups, platform
overviews — anything where background knowledge helps but nobody is required to comply
with it.

## `rounds/`: one working directory per round

**A round = one delivery with a clear acceptance target** (a batch of changes, a demo,
one capability landed). Create the round's directory at the start of work, not after —
after-the-fact cleanup always misses things.

```
rounds/<start-date>-<what-this-round-is-about>/
```

- The date in the directory name is the **start date**, not the completion date; the
  descriptive slug names what the round is actually about, not a sequence number (nobody
  remembers what round "5" was months later).
- No mandatory template inside — build what's needed: proposal, plan, dispatch workflow,
  dispatch briefs, acceptance chain, closing handoff, and all machine-written evidence
  from that round.
- When a round closes, its directory **stays in place** — it is itself the historical
  evidence for that round. Only three things happen: add an entry to the changelog, point
  the entrypoint at the new round, and copy the closing handoff into `history/`.
- Conclusions that are later overturned are **not edited in place** — write what was
  overturned into the changelog or the new round instead. Editing in place erases the
  record of "this is what we believed at the time," which has its own value.

## `history/`: an append-only chronological record

Superseded handoffs move here, ordered by time, each annotated with what superseded it.
This is not a trash bin — it's a **traceable checkpoint history**. Understanding why a
past decision was made usually means coming back here.

## `tmp/`: the single destination for everything temporary

Any directory that is "related to some sub-task but doesn't represent a durable
conclusion" goes into `tmp/` — **never create it fresh at the bundle root**. Common
anti-patterns: an unversioned repository copy, binding files that point at an execution
environment that no longer exists, a leftover archive/tarball. Each one is harmless in
isolation; **the cumulative effect is that nobody can tell which ones still matter** — the
same disease as a cluttered root.

Everything in `tmp/` is disposable by default. If something needs to be kept long-term,
that's a sign it doesn't belong in `tmp/` — move it into `reference/` (background),
`authority/` (constraint), or the relevant `rounds/<round>/` (evidence).

## Two hard rules for evidence

1. **Naming must not presuppose the outcome.** A directory name implying success (e.g.
   containing a word like "green" or "passed") may only be used **after** the actual
   result is confirmed (e.g. a verified zero exit code) — never name it first and check
   later.
2. **Evidence must be written by the process itself and be independently checkable**, not
   a narrative summary written after the fact by whoever did the work. A hand-written
   "validation notes" section is a claim, not evidence; one-off manual verification steps
   should be converted into a repeatable, automated check.

## Why organize this way

This structure solves exactly one problem: **once a task runs long enough and involves
enough people, whether a given document still applies should be readable directly from
its position in the tree**, not judged document-by-document.

- Inside `rounds/<some-round>/` ⇒ historical evidence for that round; not a current
  instruction unless `CONTEXT.md` currently points at it.
- Inside `authority/` ⇒ still binding right now.
- Inside `history/` ⇒ superseded; useful only for tracing why a decision was made.
- Inside `tmp/` ⇒ disposable by default.

This is far more reliable than "every document states its own expiry in the header" —
people forget to update expiry notes, but nobody mistakes an archived round directory for
work that's currently in progress.
