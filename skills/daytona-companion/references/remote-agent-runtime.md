# Remote Agent Runtime

Use this when a Daytona sandbox is the remote host for a Paseo/OpenCode agent tree.

## Operating model

Daytona owns the sandbox lifecycle:

- create or reconnect the sandbox,
- push/bootstrap files,
- run direct setup commands,
- expose preview ports,
- pull targeted artifacts.

Paseo owns agent dispatch and waiting. Launch remote agents from the local machine through the sandbox's preview host so the local CLI can `wait`, `logs`, `send`, and `inspect` them.

Do not spawn remote agents with `daytona exec ... paseo run ...`. That hides the agent behind a sandbox-local daemon, making local waiting and follow-up unreliable.

## One warm sandbox per iteration

For long iterations, choose one sandbox at the start and keep it running through implementation, review, evidence collection, and handoff. Parallelism should happen inside the sandbox through agents, sessions, branches, or worktrees.

Use another sandbox only when the operator explicitly approves that exception.

## Bootstrap sequence

```bash
WORK_DIR="/path/to/repo"
TASK_ID="my-iteration"

node "$DAYTONA_MGR" up \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --class large

node "$DAYTONA_MGR" adopt \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --sandbox-id "$SANDBOX_ID" \
  --remote-path "/workspace"
```

Some images default to a relative remote path after `up`. If the actual workspace is `/workspace`, always `adopt --remote-path /workspace` before `exec`, `push`, or `pull` paths matter.

Start or refresh remote Paseo:

```bash
node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'paseo daemon stop || true; PASEO_DAEMON_LISTEN=0.0.0.0:6767 paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay'
```

Start or refresh remote OpenCode Companion serve:

```bash
node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'node /home/dev/.agents/skills/opencode-companion/scripts/opencode-companion.mjs serve start'
```

Adjust the remote skill path if the image installs skills somewhere else.

## Preview host extraction

`daytona-manager preview` returns a URL. Paseo wants host:port, not the full URL.

```bash
REMOTE_PASEO_HOST="$(
  node "$DAYTONA_MGR" preview --directory "$WORK_DIR" --port 6767 --expires-in 3600 |
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const u = new URL(JSON.parse(s).url); console.log(u.host); })'
)"
```

Treat preview URLs and derived hosts as sensitive operational access material.

## Launch and wait locally

```bash
paseo provider ls --host "$REMOTE_PASEO_HOST"

paseo run --host "$REMOTE_PASEO_HOST" \
  --provider opencode \
  --model openai/gpt-5.4 \
  --mode orchestrator \
  --thinking high \
  --cwd /workspace \
  --detach \
  --title "$TASK_ID-root" \
  --prompt-file ./remote-manager-prompt.md

paseo wait --host "$REMOTE_PASEO_HOST" --timeout 1800 <agent-id>
paseo logs --host "$REMOTE_PASEO_HOST" <agent-id> --tail 20
```

If a wait times out, the agent is still running. Wait again or inspect; do not relaunch the same task.

## Restart recovery

After a sandbox restart, expect stale daemon state:

- Paseo may report a stale pid or unreachable daemon.
- OpenCode serve state may point at an old PID.
- Provider lists may be empty until the daemon is restarted.

Recovery:

```bash
node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'paseo daemon stop || true; PASEO_DAEMON_LISTEN=0.0.0.0:6767 paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay'

node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'node /home/dev/.agents/skills/opencode-companion/scripts/opencode-companion.mjs serve start'
```

## Evidence discipline

Use targeted peeks. Prefer `exec ... cat <specific-log>` or `paseo logs --tail/--since` over pulling large artifact bundles repeatedly.

Pull bundles when you need durable evidence:

- stdout/stderr,
- exit code,
- diff or patch,
- test output,
- manifest.
