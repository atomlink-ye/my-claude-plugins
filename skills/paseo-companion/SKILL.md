---
name: paseo-companion
description: "Paseo CLI companion. Load whenever the user mentions paseo, paseo agents, paseo run/send/wait/logs/attach/ls, agent IDs, sending follow-up prompts to a running agent, paseo loops, paseo schedules, paseo terminals, paseo worktrees, paseo chat, paseo permit, paseo daemon, or any question about driving AI coding agents through the paseo CLI."
user-invocable: true
---

# Paseo Companion

`paseo` is a daemon-managed CLI for launching, observing, and steering AI coding agents from the shell. Every agent has a stable ID — that ID is also the handle for sending follow-ups, reading logs, waiting, and archiving.

```bash
paseo <command> [options]
```

This skill documents the CLI. It does not pick providers, models, modes, or worktree policies — those are caller decisions.

## The common commands

These cover day-to-day usage. For everything else, see the references list at the bottom.

### `paseo run "<prompt>"` — launch an agent

Blocks until the agent finishes by default.

```bash
paseo run "implement the new auth flow"
paseo run --provider codex/gpt-5.4 "..."         # pick provider/model
paseo run --worktree feature-x "..."             # isolate in a git worktree
paseo run --cwd /path/to/repo "..."              # set working directory
paseo run --wait-timeout 30m "..."               # cap the blocking wait
paseo run -d "..."                               # detach; print agent ID and return
paseo run --json "..."                           # JSON output (machine-readable)
```

**Detached + wait pattern** (parallel work, then join):
```bash
api_id=$(paseo run -d --json "implement the API" | jq -r .id)
ui_id=$(paseo run -d --json "implement the UI"  | jq -r .id)
paseo wait "$api_id"
paseo wait "$ui_id"
```

### `paseo send <id> "<prompt>"` — continue the same agent

This is the continuation primitive. The agent ID is stable across calls, so sending a follow-up reuses the same conversation context. Do this instead of launching a new agent when the work is a follow-up to something already in flight.

```bash
paseo send <id> "now add tests for the new endpoint"
paseo send <id> --no-wait "..."                  # queue and return immediately
paseo send <id> --image screenshot.png "..."     # attach an image
paseo send <id> --prompt-file ./long-task.md     # read prompt from file
```

`<id>` accepts a unique prefix or the agent's name, not just the full UUID.

### `paseo ls` — list agents

```bash
paseo ls                       # active agents
paseo ls -a                    # include archived
paseo ls --json                # JSON output
paseo ls -q                    # IDs only (scripting)
```

Top-level flags `-q`, `--no-headers`, and `-o table|json|yaml` apply to every list command.

### `paseo wait <id>` — block until idle

```bash
paseo wait <id>
paseo wait <id> --timeout 60   # cap in seconds
```

No timeout by default. If a wait times out, the agent is **still running** — re-run `paseo wait`, do not relaunch.

### `paseo logs <id>` — view activity

```bash
paseo logs <id>                # full timeline
paseo logs <id> -f             # follow (stream)
paseo logs <id> --tail 20      # last N entries
paseo logs <id> --filter tools # only tool calls (also: text, errors, permissions)
```

### `paseo attach <id>` — stream live output interactively

```bash
paseo attach <id>              # Ctrl+C detaches without stopping the agent
```

### `paseo loop run "<prompt>" --verify "..."` — iterate worker/verifier

Run a worker, judge with the verifier, repeat until done or limits hit.

```bash
paseo loop run "fix the failing tests" \
  --verify-check "npm test" \
  --max-iterations 10
```

Use `--verify "<prompt>"` for a verifier agent, `--verify-check "<command>"` for a shell exit-0 check (repeatable), `--sleep <duration>` to pace iterations, `--max-time <duration>` for a hard cap.

## Continuation rule

Reuse before relaunch. If an agent already exists for related work, send to it (`paseo send`) rather than spinning up a new one. The agent ID **is** the session handle.

## Common gotchas

- `paseo run` blocks forever by default — that is intentional. Set `--wait-timeout` only if you need a cap.
- Never poll a running agent in a loop with `paseo ls` / `paseo inspect`. Use `paseo wait` (it blocks efficiently) or `paseo logs -f` (it streams).
- Provider strings with shell-special characters need quoting: `--provider 'claude/...'`.
- Quote the prompt argument. For multi-line or escape-heavy prompts, use `--prompt-file`.
- A timeout on `wait` does not stop the agent. Use `paseo stop <id>` to interrupt.

## Reference files

Read the matching file when the task goes beyond the common commands above.

- `references/agent-management.md` — `inspect`, `stop`, `archive`, `delete`, `agent mode/update/reload`, labels.
- `references/providers-and-modes.md` — `provider ls`, `provider models`, `--provider`, `--model`, `--mode`, `--thinking`.
- `references/worktree-and-cwd.md` — `--worktree`, `--base`, `--cwd`, `paseo worktree ls/archive`.
- `references/loop-and-schedule.md` — full `loop run` options, `schedule create/ls/inspect/logs/pause/resume/delete`.
- `references/terminal.md` — `terminal create/ls/kill/capture/send-keys` and key-token reference.
- `references/chat-and-permit.md` — `chat` rooms (`create/post/read/wait`) and `permit ls/allow/deny`.
- `references/daemon-and-onboarding.md` — `onboard`, `daemon start/stop/restart/status/pair`, `--host`.
- `references/output-formats.md` — `--json`, `-q`, `--no-headers`, `--no-color`, `--output-schema`.
