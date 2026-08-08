---
name: paseo-companion
description: "Paseo CLI companion. Load whenever the user mentions paseo, paseo agents, paseo run/send/wait/logs/attach/ls, agent IDs, sending follow-ups to a running agent, loops, schedules, terminals, worktrees, chat, permits, daemon operations, or host/port targeting."
user-invocable: true
---

# Paseo Companion

Paseo is a daemon-managed CLI for launching, observing, and steering AI coding agents. Every agent gets a stable ID that serves as the handle for all subsequent operations — follow-ups, logs, waiting, archiving.

This skill is a **runtime adapter**. It documents how to drive the Paseo CLI; it does **not** decide whether a task should run through Paseo at all, on the local daemon or a remote one, or with which model. Those choices belong to the orchestration layer (`team-lead-orchestration`) and any local routing profile that applies (e.g. a personalized routing skill).

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
api_id=$(paseo run -d --json --title api-lane "implement the API" | jq -r .id)
ui_id=$(paseo run -d --json --title ui-lane "implement the UI"  | jq -r .id)

# ... do other work ...

paseo wait "$api_id"
paseo wait "$ui_id"
```

If `wait` times out, the agent is still running. Inspect state or wait again; do not relaunch the same work.

### Target a remote daemon

When a remote daemon is exposed through a tunnel or Daytona preview, pass `--host` to every command that should address that daemon:

```bash
paseo provider ls --host "$REMOTE_PASEO_HOST"
paseo run --host "$REMOTE_PASEO_HOST" -d --provider opencode --mode orchestrator --cwd /workspace --prompt-file ./task.md
paseo wait --host "$REMOTE_PASEO_HOST" --timeout 1800 <id>
paseo logs --host "$REMOTE_PASEO_HOST" <id> --tail 20
```

Use the host:port form, not a full `http://...` preview URL.

### Recommended workflow: manager loop over a long-running agent

For a bounded task you dispatch and then check on periodically — rather than babysit synchronously — drive it as a loop, not a single blocking call:

1. **Dispatch one bounded task** with an explicit scope boundary in the prompt (what's in, what's out, what "done" means). Detach it:
   ```bash
   id=$(paseo run -d --json --title <lane-name> --workspace <workspace> --cwd <path> "<scoped prompt>" | jq -r .id)
   ```
   Always pass `--workspace` explicitly (see `references/worktree-and-cwd.md`) if the run should show up grouped correctly.
2. **Arm exactly one wait**, sized to how long the task should reasonably take:
   ```bash
   paseo wait "$id" --timeout <n>
   ```
3. **On wake, verify before deciding** — read `paseo logs "$id" --tail N` or `paseo inspect "$id" --json`, and if the agent claims it delegated to a sub-agent or finished a check, cross-check that claim (see "Don't trust an agent's self-report" in `references/agent-management.md`) rather than accepting the narrative.
4. **Steer in place, don't relaunch.** If it drifted (scope creep, wrong approach, skipped the actual ask), send a correction into the *same* agent with `paseo send --no-wait "$id" "<correction>"` and re-arm one wait. Do not spin up a second agent for a course correction on work already in flight.
5. **On completion, exercise the result yourself** before accepting it — run the feature, read the diff, run the test — rather than taking the agent's own completion report at face value.

The two failure modes this avoids: using a blocking `paseo send` as your check-in mechanism (it silently becomes your polling interval — see Non-negotiables), and re-arming a new `paseo wait` after every interim peek (a single armed wait already returns on completion *or* timeout, so stacking waits just produces duplicate wake-ups). Audit stray waits with `ps -eo pid,command | grep "[p]aseo wait"`.

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
--provider <provider/model>   # pick provider/model (decided by routing profile, not this skill)
--cwd /path/to/repo            # set working directory
--host 10.0.0.8:6767           # target a remote daemon
--json                         # machine-readable output
-d                             # detach (return immediately, print agent ID)
--title auth-lane              # stable human name for tracking
--label area=backend           # metadata for filtering
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
| Drive agents on a remote daemon through preview/tunnel host routing | `references/remote-host-orchestration.md` |
| Script/automate Paseo output, JSON/YAML formats, schema validation | `references/output-formats.md` |
| Orchestrating multiple child agents and need to stop losing track of them (unattended waits, expired reminders, unexplained parks) | `references/manager-safety-net.md` |

## Daemon health triage

When `paseo status` shows `Local Daemon: unresponsive` / `Connected Daemon: unreachable` but still reports a PID, do not assume the daemon is healthy just because the supervisor process exists.

Check in this order:

```bash
paseo status
ps -p <pid> -o pid=,ppid=,stat=,start=,etime=,command=
lsof -nP -iTCP:6767 -sTCP:LISTEN
```

Then inspect the daemon log near the end:

```bash
tail -n 120 ~/.paseo/daemon.log
```

A real local failure seen on this machine after upgrading Paseo CLI was a worker crash loop caused by a Homebrew dylib mismatch:

```text
dyld: Library not loaded: /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib
Referenced from: /opt/homebrew/Cellar/node/25.8.2/bin/node
```

In that state:
- the supervisor PID stays alive,
- the websocket port is not actually healthy,
- `Daemon Version` may show `-`,
- and the log repeats `Worker crashed (SIGABRT). Restarting worker...`.

Treat this as a local runtime/dependency problem (Node/Homebrew dylib mismatch), not a normal restart delay.

## Non-negotiables

- **Reuse before relaunch.** If an agent already exists for related work, `paseo send` to it — don't spin up a new one. Reuse when it's the same task and the same context (a direct continuation, not a topic change) and that context hasn't gone stale or noisy; otherwise start fresh rather than let a long-lived session keep absorbing unrelated work.
- **Wait, don't poll.** Never loop on `paseo ls` / `paseo inspect`. Use `paseo wait <id>` (blocks efficiently) or `paseo logs <id> -f` (streams).
- **One armed wait per agent.** A single `paseo wait <id>` already returns on either completion or timeout — that covers both "it finished" and "check on it again." Don't re-arm a new wait after every interim `paseo logs`/`paseo inspect` peek; the peek is free and doesn't consume the pending wait. Stacking waits produces duplicate wake-ups on the same event.
- **Detach follow-ups too.** Plain `paseo send <id> "..."` blocks until that turn finishes, just like `run` without `-d`. If you're driving your own check-in cadence with `paseo wait`, use `paseo send --no-wait <id> "..."` — otherwise the blocking send quietly becomes your polling interval.
- **Timeout doesn't stop.** If `wait` times out, the agent is still running. Use `paseo stop <id>` to actually interrupt.
- **Carry `--host` through.** A remote agent ID is only useful when later `wait`, `logs`, `send`, and `inspect` target the same daemon host.
- **Quote prompts.** For multi-line or escape-heavy prompts, use `--prompt-file`.
