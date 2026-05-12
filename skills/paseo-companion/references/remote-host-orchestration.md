# Remote Host Orchestration

Use this when Paseo agents run on a daemon that is not the default local daemon, such as a Daytona sandbox exposed through a preview URL or tunnel.

## Host routing rule

Every command that refers to a remote agent must target the same daemon host:

```bash
paseo run --host "$REMOTE_PASEO_HOST" ...
paseo wait --host "$REMOTE_PASEO_HOST" <id>
paseo logs --host "$REMOTE_PASEO_HOST" <id>
paseo send --host "$REMOTE_PASEO_HOST" <id> --prompt-file ./follow-up.md
paseo inspect --host "$REMOTE_PASEO_HOST" <id>
```

If `run` used `--host`, later `wait/logs/send/inspect` without `--host` will look at the local daemon and may appear to lose the agent.

## Preview URL handling

Paseo expects host:port, not a full URL:

```bash
REMOTE_PASEO_HOST="6767-example.proxy.example.test:4000"
paseo provider ls --host "$REMOTE_PASEO_HOST"
```

Strip `http://` or `https://` from tunnel and preview URLs before passing them to `--host`.

## Launch pattern

Use detached agents for long remote work:

```bash
agent_id="$(
  paseo run --host "$REMOTE_PASEO_HOST" \
    --provider opencode \
    --model <provider/model> \
    --mode orchestrator \
    --thinking high \
    --cwd /workspace \
    --detach \
    --json \
    --title "remote-root" \
    --label task=my-iteration \
    --prompt-file ./remote-root.md |
  jq -r .id
)"
```

Use `--title` and labels so managers/leaves can be found in `ls`, logs, and reports.

## Waiting and observing

Prefer event-driven wait:

```bash
paseo wait --host "$REMOTE_PASEO_HOST" --timeout 1800 "$agent_id"
```

If the wait times out:

1. The agent is still running.
2. Check current state with `paseo inspect --host "$REMOTE_PASEO_HOST" "$agent_id"` or `paseo ls --host "$REMOTE_PASEO_HOST" --json`.
3. Use `paseo logs --host "$REMOTE_PASEO_HOST" "$agent_id" --tail 20` or `--since <time>` for a small progress view.
4. Wait again, send a follow-up, or stop only after inspecting the actual state.

Do not replace `wait` with a manual loop around `ls` or `inspect`.

## Follow-ups

Use `--prompt-file` for long or structured follow-ups:

```bash
paseo send --host "$REMOTE_PASEO_HOST" --no-wait --prompt-file ./follow-up.md "$agent_id"
```

`--no-wait` queues the message and returns. Use `wait` or `logs -f` afterward.

## Remote daemon startup

When starting the remote daemon yourself, bind it explicitly:

```bash
PASEO_DAEMON_LISTEN=0.0.0.0:6767 paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay
```

If a restart ignores `--listen` and falls back to localhost or another port, stop it and start again with `PASEO_DAEMON_LISTEN` set. Stale pid/config state can otherwise keep the old listener.

## What not to do

- Do not start remote agents by shelling into the host and running `paseo run` there if the local operator needs to wait or send follow-ups.
- Do not mix local and remote daemon commands for the same agent ID.
- Do not treat `wait --timeout` as cancellation.
- Do not paste huge prompts directly into the shell; use `--prompt-file`.
