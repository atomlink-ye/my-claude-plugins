# Daemon and onboarding

Paseo runs as a local daemon that the CLI talks to. Most users only touch this layer during first-time setup or when something breaks.

## `paseo onboard` — first-time setup

```bash
paseo onboard
```

Runs first-time setup, starts the daemon, and prints pairing instructions. Common flags:

| Flag | Meaning |
|---|---|
| `--listen <listen>` | Listen target — `host:port`, port number, or unix socket path. |
| `--port <port>` | Port (default `6767`). |
| `--home <path>` | Paseo home directory (default `~/.paseo`). |
| `--no-relay` | Disable the relay connection. |
| `--no-mcp` | Disable the agent MCP HTTP endpoint. |
| `--hostnames <hosts>` | Daemon hostnames, comma-separated, or `true` for any. |
| `--timeout <seconds>` | Max time to wait for daemon readiness (default `600`). |
| `--voice <mode>` | Voice setup: `ask`, `enable`, `disable` (default `ask`). |

## `paseo daemon` — manage the daemon

```bash
paseo daemon start
paseo daemon stop
paseo daemon restart
paseo daemon status
paseo daemon pair       # print pairing QR code and link
```

Top-level shortcuts exist for the most common actions:

| Top-level | Equivalent |
|---|---|
| `paseo start` | `paseo daemon start` |
| `paseo status` | `paseo daemon status` |
| `paseo restart` | `paseo daemon restart` |

## Talking to a non-default daemon

Most paseo commands accept `--host <host>` to target a remote or non-default daemon. Without it, the CLI prefers the local socket/pipe and falls back to `localhost:6767`.

```bash
paseo run --host my-host:6767 "..."
paseo wait --host my-host:6767 <id>
paseo logs --host my-host:6767 <id>
```

Use the same `--host` for every later command that references an agent created on that daemon.

## Remote listener startup

For remote sandboxes or containers, bind the daemon to a non-localhost listener:

```bash
PASEO_DAEMON_LISTEN=0.0.0.0:6767 paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay
```

If a restart appears to ignore `--listen`, stop the daemon and start it again with `PASEO_DAEMON_LISTEN` set. Stale daemon config or pid state can otherwise preserve the old listener.

## Troubleshooting

- `paseo run` errors with a connection failure → check `paseo daemon status`. Run `paseo daemon start` (or `paseo start`) if the daemon is not running.
- Auth errors from the underlying provider → the daemon shells out to the provider's CLI and inherits its env. Make sure the relevant provider auth is in place in the same shell that started the daemon.
- Claude-specific pitfall: a stale `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in the daemon's process environment can override a valid local Claude Max OAuth login and produce `401 Invalid bearer token`, even when `claude auth status` says logged in. Verify the daemon env with `ps eww -p $(pgrep -f paseo.*supervisor-entrypoint | head -1)` or equivalent, then restart the daemon from a clean environment, for example:

```bash
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY paseo daemon stop
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY paseo daemon start
```

  Also verify the local CLI separately with the same env cleanup if you need to distinguish a shell-env problem from a daemon-env problem: `env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY claude -p "Reply with exactly OK" --max-turns 1`.
- After updating paseo or its providers → `paseo daemon restart` to reload.
- `paseo status` / `paseo daemon status` can falsely report `Local Daemon: unresponsive` even when the daemon is actually up. On this machine with paseo `0.1.89`, the websocket can be reachable and the daemon can be listening on `127.0.0.1:6767`, but the status command still downgrades health because its internal archived-agent probe times out. Practical verification steps:
  1. Check the process tree for `Paseo Supervisor` / `Paseo Daemon`.
  2. Check that `127.0.0.1:6767` is actually listening.
  3. Check the daemon log for `Worker ready` and `Server listening on http://127.0.0.1:6767`.
  4. Run `paseo ls --json`. If that works but `paseo ls -a --json` fails with `Failed to list agents: Timeout waiting for message (10000ms)`, treat the daemon as running and the status output as a large-archive timeout issue rather than a startup failure.
- Remote agent ID appears missing → repeat the command with the same `--host` used at launch.
