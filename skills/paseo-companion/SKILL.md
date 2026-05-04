---
name: paseo-companion
description: "Paseo CLI companion. Load whenever the user mentions paseo, paseo agents, paseo run/send/wait/logs/attach/ls, agent IDs, sending follow-ups to a running agent, loops, schedules, terminals, worktrees, chat, permits, daemon operations, or host/port targeting."
user-invocable: true
---

# Paseo Companion

Paseo is a daemon-managed CLI for launching, observing, and steering AI coding agents. Every agent gets a stable ID that serves as the handle for all subsequent operations — follow-ups, logs, waiting, archiving.

```bash
paseo <command> [options]
```

## Typical workflows

### Run a single task and wait for completion

```bash
paseo run "implement the new auth flow"
```

Blocks until the agent finishes. Add `--wait-timeout 30m` to cap the wait.

### Send a follow-up to the same agent

Reuse before relaunch — if an agent already exists for related work, continue it:

```bash
paseo send <id> "now add tests for the new endpoint"
```

`<id>` accepts a unique prefix or the agent name, not just the full UUID.

### Run multiple agents in parallel

Detach agents, do other work, then join:

```bash
api_id=$(paseo run -d --json "implement the API" | jq -r .id)
ui_id=$(paseo run -d --json "implement the UI"  | jq -r .id)

# ... do other work ...

paseo wait "$api_id"
paseo wait "$ui_id"
```

### Isolate work in a git worktree

```bash
paseo run --worktree feature-x "implement feature X"
paseo run --worktree experiment-y --base develop "try approach Y"
```

### Iterate until tests pass

```bash
paseo loop run "fix the failing tests" \
  --verify-check "npm test" \
  --max-iterations 10
```

Use `--verify "<prompt>"` for an agent-based verifier instead of a shell command.

### Monitor a running agent

```bash
paseo logs <id> -f            # stream live output
paseo attach <id>             # interactive stream (Ctrl+C detaches, doesn't stop)
paseo inspect <id>            # detailed metadata snapshot
```

### List and manage agents

```bash
paseo ls                      # active agents
paseo ls -a                   # include archived
paseo stop <id>               # interrupt a running agent
paseo archive <id>            # soft-delete
paseo delete <id>             # hard-delete
```

## Common options

```bash
--provider codex/gpt-5.4      # pick provider/model
--cwd /path/to/repo            # set working directory
--host 10.0.0.8:6767           # target a remote daemon
--json                         # machine-readable output
-d                             # detach (return immediately, print agent ID)
--prompt-file ./task.md        # read prompt from file (for long/complex prompts)
--image screenshot.png         # attach an image to the prompt
```

## Command map

| Goal | Command |
|---|---|
| Launch and wait | `paseo run "PROMPT"` |
| Launch detached | `paseo run -d "PROMPT"` |
| Continue an agent | `paseo send <id> "PROMPT"` |
| Wait for completion | `paseo wait <id>` |
| Stream logs | `paseo logs <id> -f` |
| Attach interactively | `paseo attach <id>` |
| List agents | `paseo ls [-a]` |
| Stop/archive/delete | `paseo stop|archive|delete <id>` |
| Target remote daemon | add `--host <ip>:<port>` |

## When to read references

| You need to... | Read |
|---|---|
| Inspect, stop, archive, delete agents; update metadata or labels | `references/agent-management.md` |
| Discover providers/models, select a provider, switch modes, enable thinking | `references/providers-and-modes.md` |
| Use git worktrees for isolation, manage Paseo-created worktrees | `references/worktree-and-cwd.md` |
| Set up verification loops or recurring scheduled tasks | `references/loop-and-schedule.md` |
| Create persistent terminals, send keystrokes, capture output | `references/terminal.md` |
| Set up inter-agent chat rooms or handle permission requests | `references/chat-and-permit.md` |
| First-time setup, daemon start/stop/restart, connect to remote daemon | `references/daemon-and-onboarding.md` |
| Script/automate Paseo output, JSON/YAML formats, schema validation | `references/output-formats.md` |

## Non-negotiables

- **Reuse before relaunch.** If an agent already exists for related work, `paseo send` to it — don't spin up a new one.
- **Wait, don't poll.** Never loop on `paseo ls` / `paseo inspect`. Use `paseo wait <id>` (blocks efficiently) or `paseo logs <id> -f` (streams).
- **Timeout doesn't stop.** If `wait` times out, the agent is still running. Use `paseo stop <id>` to actually interrupt.
- **Quote prompts.** For multi-line or escape-heavy prompts, use `--prompt-file`.
