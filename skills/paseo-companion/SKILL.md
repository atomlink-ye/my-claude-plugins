---
name: paseo-companion
description: "Paseo CLI companion. Load whenever the user mentions paseo, paseo agents, paseo run/send/wait/logs/attach/ls, agent IDs, sending follow-ups to a running agent, loops, schedules, terminals, worktrees, chat, permits, daemon operations, or host/port targeting."
user-invocable: true
---

# Paseo Companion

Paseo is a daemon-managed CLI for launching, observing, and steering AI coding agents. Every agent gets a stable ID that serves as the handle for all subsequent operations — follow-ups, logs, waiting, archiving.

This skill is a **runtime adapter**. It documents how to drive the Paseo CLI; it does **not** decide whether a task should run through Paseo at all, on the local daemon or a remote one, or with which model. Those choices belong to the orchestration layer (`team-lead-orchestration`) and any local routing profile that applies (e.g. a personalized routing skill).

The companion is a shared local singleton. Start or reuse it from any skill
consumer with:

```bash
"${SKILL_ROOT}/scripts/ensure-running"
```

The launcher locates the repo-relative production build, keeps state/log/pid
files outside the source tree by default, and deliberately does not use
`PASEO_AGENT_ID`; identity is supplied by each request.

## Shared companion messages

For durable asynchronous worker content, use the local companion's message queue:

```sh
curl -sS -X POST http://127.0.0.1:8787/messages \
  -H 'content-type: application/json' \
  -d '{"to":"worker-id","from":"sender-agent-id","body":"Please review the diff","delivery":"on-idle","mode":"ack"}'
```

The queue persists before delivery. Default `delivery:"on-idle"` arms a
repeating one-minute heartbeat for the coalesced batch. Busy ticks are silently
skipped and the next tick retries. `delivery:"interrupt"` sends immediately via
`paseo send --no-wait`. Default `mode:"notify"` clears after
accepted delivery; use `mode:"ack"` for DELETE acknowledgement, or `mode:"reply"`
with `replyTo` to answer and resolve a parent. Acceptance is daemon receipt, not
proof the recipient processed the prompt.

**Manager-safe default:** if the recipient is a Claude Manager, or may currently
be running subagents, ordinary updates from Owner Deputy or Workers MUST use
`POST /messages` with `delivery:"on-idle"`. A direct `paseo send` interrupts the
Manager's active turn and can cancel its in-flight subagents. Use
`delivery:"interrupt"` only for a correction that must change what the Manager
is doing right now and whose avoided rework is worth that cancellation risk.

Delivery controls both timing and the Paseo transport. `interrupt` genuinely
interrupts a busy recipient and its complete prompt is visible in `paseo logs`.
`on-idle` uses a heartbeat that runs only once the recipient is idle; its prompt
is not visible in `paseo logs`. Confirm on-idle delivery from `GET /messages`
(ack/reply modes) or `GET /reminders/:id`, whose audit is updated only after the
heartbeat reports `lastRunAt`. See `paseo-reminder/UPSTREAM.md`.

Automatic heartbeat-recovery snapshots and ordinary worker messages use the same
turn-boundary send transport. `DELETE /messages/:id` acknowledges/removes either a
pending or delivered record and is idempotent after a prior acknowledgement.
Normally auto-cleared notify delivery is also idempotent while its bounded
delivery audit remains (the newest 50 terminal schedules); a truly unknown or
pruned ID is 404.

Use `GET /messages?to=worker-id` to observe pending and delivered records before
acknowledging them.

Companion-generated prompts always arrive in a tagged envelope so they are
visibly distinct from human input. A coalesced batch has one `<item>` per message:

```xml
<paseo-reminder-delivery to="worker-id" kind="message">
  <note marker="NOT_USER_INPUT">Automated delivery from paseo-reminder. This is system-generated context, not a request from a person. Process each item exactly once. Reply through paseo-reminder only when an item explicitly requests it.</note>
  <item id="MESSAGE_ID" from="sender-agent-id" at="2026-08-12T05:00:00.000Z" urgency="normal" mode="ack" kind="message">
    <body>Please review the diff</body>
    <ack>arcp message ack MESSAGE_ID --reason processed</ack>
  </item>
</paseo-reminder-delivery>
```

Reminder, watchdog, and compact-wake deliveries use the same envelope with one
item and the corresponding `kind`. Content is escaped; `<ack>` contains the
copy-pasteable acknowledgement or cancellation command when one exists.
Ordinary `mode:"notify"` messages omit `<ack>` and clear automatically.

The companion is a shared local singleton; identity-bearing requests carry the
calling agent ID rather than relying on process environment. Child tracking is
explicit or discovered only for children whose parseable
`CreatedAt`/`createdAt` is strictly after service startup. Missing timestamps are
not auto-enrolled. `GET /children` returns tracked children only, with public
tracking metadata in `source` and `addedAt`; use either
`PUT /children/:childId?agentId=manager-id` or the compatible `/watch` alias to
track a pair. Explicit PUT always ensures a companion child-watch even when a
separate `paseo wait` source is already live. DELETE with a reason persists an opt-out:

```sh
curl -X PUT 'http://127.0.0.1:8787/children/child-id?agentId=manager-id'
arcp child unwatch child-id --agent manager-id --reason 'no longer needed'
```

This supersedes the older “worker intermediate updates are unavailable” guidance:
use `/messages` for durable updates, and reserve `send` for safe direct steering.

Companion reminders separate one-shot and repeating intent. `mode:"once"` accepts
`delaySeconds` or an absolute `targetAt`; `mode:"repeat"` requires an explicit
`everySeconds` and may set `maxRuns`. Both deliver through the companion queue.
The target is the earliest eligible delivery time, not a deadline: default
on-idle delivery still waits for an idle heartbeat tick, so a busy recipient
receives the reminder later. Responses expose
`schedulingKind` (`once`, `repeat`, `cron`, or `in-process`); a healthy
in-process watch can intentionally have no `nextRunAt`. `agentId` may be in the
body or query, and caller-supplied reminder IDs are rejected.
The reminder content field is `message`, not the message API's `body`:

```sh
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Review queued work","mode":"once","delaySeconds":1800}'
curl -sS -X POST http://127.0.0.1:8787/reminders -H 'content-type: application/json' -d '{"agentId":"agent-id","message":"Check worker status","mode":"repeat","everySeconds":1800,"maxRuns":3}'
curl -sS 'http://127.0.0.1:8787/reminders?agentId=agent-id'
curl -sS 'http://127.0.0.1:8787/reminders/REMINDER_ID'
```

The list endpoint optionally filters by `agentId`; the exact endpoint preserves
the record's `status`, `nextRunAt`, `lastFiredAt`, mode, and delivery metadata.

> **A reminder is a nudge, not a compliance gate.** Three limits, all observed in production
> (2026-08-13 round: 8 deliveries fired, 3 were self-exempted by the recipient):
>
> - `on-idle` **skips busy ticks** — "an `everySeconds=2700` timer exists" does NOT mean
>   "a processable deadline arrives every 45 minutes." One 45-minute gap had no instance at all.
> - `lastFiredAt` / delivery status prove **transmission**, not **processing**, and never **closure**.
> - A reminder addressed to the same agent that owes the obligation enforces nothing:
>   that agent can always decide this particular firing doesn't matter.
>
> A timed obligation is enforced only when an **independent recipient** performs it and a
> durable `ACCEPT`/`REFUSE` record closes it. If your design can't do that, label the state
> `UNENFORCED` rather than calling it a gate.

Choose the primitive by intent:

| Need | Use |
|---|---|
| Deliberate immediate follow-up and interruption is safe | `paseo send` |
| Repeating/time-based nudge with explicit acknowledgement | Companion `POST /reminders` |
| Durable asynchronous worker content, coalesced and delivered on an idle heartbeat tick | Companion `POST /messages` |

```bash
paseo <command> [options]
```

## Typical workflows

### Reuse the Project; choose Workspace by checkout

Paseo's visible hierarchy is:

```text
Project = one repository/product identity
  → Workspace = one exact checkout/worktree and its supervised state
    → Tab = one Agent session in that Workspace
```

Paseo groups sessions by **workspace**, not merely by identical `--cwd`. If every
`paseo run` omits `--workspace`, the daemon may create multiple same-named
workspaces for the same directory. Worse, creating workspaces from pre-created
external git-worktree paths without `--project` can register each worktree as a
separate Project even when all have the same `mainRepoRoot`.

For one task or round:

- same repo + same exact checkout → same Workspace, different Agent tabs;
- same repo + different writer worktrees → same Project, different worktree Workspaces;
- do **not** put different worktree paths into one Workspace: its cwd/scripts/terminals/archive lifecycle represent one checkout, and `--cwd` may normalize back to the Workspace root.

The canonical parallel-writer flow is to register/select the repository Project
once, then let Paseo create each branch Workspace under that Project:

```bash
project=$(paseo project ls --json | jq -r \
  '.[] | select(.path == "/absolute/repo/root") | .projectId')

ws=$(paseo workspace create --json \
  --project "$project" \
  --isolation worktree \
  --path /absolute/repo/root \
  --mode branch-off \
  --new-branch fix/lane-a \
  --base main \
  --worktree-slug lane-a \
  --title "<round> · lane-a" | jq -r '.workspaceId')

paseo run -d --workspace "$ws" \
  --provider codex --model gpt-5.6-terra --thinking high \
  --mode full-access --title "Worker · lane-a" "<goal>"
```

For an already-existing branch, use `--mode checkout-branch --branch <name>`.
This creates a Paseo-managed worktree. If an external worktree already exists,
do not create a second checkout of the same branch; either keep its existing
Workspace for that round or recreate it safely through the canonical Project
before dispatch. Existing Agents cannot be moved between Workspaces.

For several agents that intentionally share the **same exact checkout** (for
example a read-only Oracle and Auditor), create or choose one named Workspace
and reuse its ID so they appear as tabs:

```bash
ws=$(paseo workspace create \
  --isolation local \
  --path /absolute/task/root \
  --title "Owner Deputy · <round name>" \
  --json | jq -r '.workspaceId')

paseo run -d --workspace "$ws" \
  --provider codex --model gpt-5.6-terra --thinking medium \
  --title "Audit A · manager decisions" "<prompt>"

paseo run -d --workspace "$ws" \
  --provider codex --model gpt-5.6-terra --thinking medium \
  --title "Audit B · quota and topology" "<prompt>"
```

Operational rules:

- **Same task/round + same execution directory → same workspace ID.** Related
  sessions then appear as tabs inside one visible workspace.
- Give the workspace a task-level title; give each agent a lane-level `--title`.
- `--cwd` chooses process location; `--workspace` chooses UI/ownership grouping.
  Pass both when the distinction matters, and verify with `paseo inspect` plus
  `paseo workspace ls --json`.
- Rename an existing workspace with
  `paseo workspace rename <workspace-id> "<title>"`.
- The current CLI cannot move an existing agent to another workspace. If a run
  accidentally created a duplicate workspace, let/cause its agent to reach a
  safe terminal state, preserve its result, then archive that extra workspace;
  use the canonical workspace ID for all subsequent runs.
- A shared, well-named workspace is part of the audit surface: the Owner can see
  Worker state, tool calls, and progress without asking the Manager to relay it.

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

This direct form is for an idle agent or deliberate interruption. For a Manager
or any agent that may have active subagents, queue the follow-up through
`POST /messages` with `delivery:"on-idle"` instead.

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
- **Do not directly send ordinary updates to a busy Manager.** Queue Owner Deputy / Worker / subagent updates through paseo-reminder `/messages` with `delivery:on-idle`; direct `paseo send` may cancel the Manager's active subagents.
- **Wait, don't poll.** Never loop on `paseo ls` / `paseo inspect`. Use `paseo wait <id>` (blocks efficiently) or `paseo logs <id> -f` (streams).
- **One armed wait per agent.** A single `paseo wait <id>` already returns on either completion or timeout — that covers both "it finished" and "check on it again." Don't re-arm a new wait after every interim `paseo logs`/`paseo inspect` peek; the peek is free and doesn't consume the pending wait. Stacking waits produces duplicate wake-ups on the same event.
- **Detach follow-ups too.** Plain `paseo send <id> "..."` blocks until that turn finishes, just like `run` without `-d`. If you're driving your own check-in cadence with `paseo wait`, use `paseo send --no-wait <id> "..."` — otherwise the blocking send quietly becomes your polling interval.
- **Timeout doesn't stop.** If `wait` times out, the agent is still running. Use `paseo stop <id>` to actually interrupt.
- **Carry `--host` through.** A remote agent ID is only useful when later `wait`, `logs`, `send`, and `inspect` target the same daemon host.
- **Quote prompts.** For multi-line or escape-heavy prompts, use `--prompt-file`.
