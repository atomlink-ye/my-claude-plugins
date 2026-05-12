# Optional reference — Daytona remote lane for team leads

Read this only when the user explicitly wants a **remote sandbox lane**. The main `opencode-orchestrator` skill stays local-first.

## When to choose Daytona

Choose the remote lane when one or more of these are true:
- local execution is risky or too stateful
- you need a clean isolated environment
- you need a stable remote preview URL for a service or daemon
- you want a long-running warm sandbox across multiple slices
- the user explicitly asks for Daytona, remote execution, or sandbox-based work

If not, stay on the default local team-lead path.

## Core model

```text
Local Team Lead
  -> prepares scope, bundle, acceptance bar
  -> owns final judgment
  -> dispatches from local into one remote Daytona sandbox

Remote Daytona sandbox
  -> hosts the repo/worktrees/runtime
  -> runs remote Paseo / OpenCode execution lanes
  -> writes reports, logs, and gate artifacts
```

Remote rule: **local prepares and accepts; remote executes.**

## Keep this optional, not primary

Do not make Daytona the default just because it exists.

Use it as an expansion path for isolation, scale, preview, or remote-hosted execution. For ordinary local TL workflows, stay local.

## One warm sandbox rule

Prefer one warm sandbox per iteration:
- reuse the same sandbox across slices when the iteration is coherent
- keep repo worktrees under `/workspace/.worktrees/`
- do not create multiple sandboxes mid-iteration unless the user explicitly approves that exception

## Dispatch rule: bootstrap with Daytona, dispatch agents with local `paseo --host`

This is the most important rule.

Use Daytona tooling for:
- sandbox lifecycle
- file transfer
- bootstrap commands
- preview URLs
- artifact pullback

Do **not** spawn remote agents with:

```bash
daytona exec ... paseo run ...
```

That hides the agent behind the sandbox shell and makes local wait/send/review flows worse.

Instead:
1. bootstrap the sandbox and remote daemon
2. expose the daemon port with a preview URL
3. dispatch from **local** using `paseo run --host "$HOST" ...`
4. wait from **local** using `paseo wait --host "$HOST" ...`
5. send fix rounds from **local** using `paseo send --host "$HOST" ...`

## Minimal flow

```bash
WORK_DIR="/path/to/repo"
DAYTONA_MGR="$HOME/.agents/skills/daytona-companion/scripts/daytona-manager.mjs"

# 1) Start or reconnect one sandbox
node "$DAYTONA_MGR" up \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --class large

# 2) Pin the remote workspace
node "$DAYTONA_MGR" adopt \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --sandbox-id "$SANDBOX_ID" \
  --remote-path "/workspace"

# 3) Bootstrap remote paseo + opencode
node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'paseo daemon stop || true; paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay'
node "$DAYTONA_MGR" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'node /home/dev/.agents/skills/opencode-companion/scripts/opencode-companion.mjs serve start'

# 4) Expose the daemon and derive host:port
HOST="$({
  node "$DAYTONA_MGR" preview --directory "$WORK_DIR" --port 6767 --expires-in 3600
} | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(new URL(JSON.parse(s).url).host))')"

# 5) Dispatch the remote lane from local
paseo run --host "$HOST" \
  --provider opencode \
  --model openai/gpt-5.4 \
  --mode orchestrator \
  --thinking high \
  --cwd /workspace/.worktrees/<slice-id>/integration \
  --detach \
  "Read /workspace/tasks/remote/<slice-id>/prompt.md and execute it."

# 6) Wait or continue from local
paseo wait --host "$HOST" --timeout 1800 <agent-id>
paseo send --host "$HOST" --no-wait --prompt-file ./fix-round.md <agent-id>
```

Run waits in host background when possible so the local team lead can keep orchestrating.

## Remote bundle contract

For non-trivial remote work, prepare a self-contained bundle under:

```text
tasks/remote/<task-id>/
  HANDOFF.md
  context-index.md
  prompt.md
  env-contract.md
  acceptance.md
  commands.sh
  artifacts/
```

Minimum meanings:
- `HANDOFF.md` — scope, non-goals, boundaries
- `context-index.md` — exact files/docs/links to read first
- `prompt.md` — final remote prompt
- `env-contract.md` — paths, tools, model, runtime assumptions, env variable names only
- `acceptance.md` — required checks and evidence
- `commands.sh` — reproducible gate catalog

The remote side should assume **zero implicit local context**.

## Review and acceptance

Default remote pattern:
1. remote lane implements and writes artifacts
2. local team lead pulls branch/report/logs back
3. local team lead runs an independent review lane when the stakes are real
4. fix rounds go back to the same remote agent when the thread is continuous
5. merge or accept only after local acceptance is green

## Common mistakes

- Making Daytona the default for simple local work
- Starting remote agents through `daytona exec ... paseo run ...`
- Creating multiple sandboxes in one iteration without a real need
- Polling status in a tight loop instead of using wait/notify
- Accepting a remote summary without reading artifacts or verifying repo state
- Forgetting to pin the remote workspace path after `up` / restart

## Read next

- `daytona-companion` — sandbox lifecycle, push/pull, preview, troubleshooting
- `opencode-companion` — runtime session behavior inside the remote environment
