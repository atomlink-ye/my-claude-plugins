# Worktrees and working directory

Paseo isolates per-agent work via git worktrees so multiple agents can edit the same repo in parallel without conflicts.

## `--cwd <path>` — set the agent's working directory

```bash
paseo run --cwd /path/to/repo "..."
```

Defaults to the current directory. Affects where the agent's commands run; does not create a branch or worktree.

## `--worktree <name>` — run inside a fresh git worktree

```bash
paseo run --worktree feature-x "..."
paseo run --worktree feature-x --base main "..."
```

Creates a new git worktree named `<name>` and a matching branch, then runs the agent inside it. `--base <branch>` overrides the source branch (defaults to the current branch).

The agent operates on the worktree, leaving the parent checkout untouched. Combine with `-d` to launch parallel feature work in isolation:

```bash
paseo run -d --worktree exp-a --json "try approach A" | jq -r .id
paseo run -d --worktree exp-b --json "try approach B" | jq -r .id
```

## `paseo worktree ls` — list paseo-managed worktrees

```bash
paseo worktree ls
paseo worktree ls --json
```

## `paseo worktree archive <name>` — remove a worktree and its branch

```bash
paseo worktree archive feature-x
```

Removes both the worktree directory and the associated branch. Use after the agent's work has been merged or discarded.

## Notes

- `paseo worktree` only manages worktrees paseo created. Plain `git worktree` directories are unaffected.
- Multiple agents can target the same worktree via `--cwd <worktree-path>` if you want them to share state, but expect conflicts unless they edit disjoint files.
