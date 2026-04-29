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
paseo --host localhost:6767 ls
paseo run --host my-host:6767 "..."
```

## Troubleshooting

- `paseo run` errors with a connection failure → check `paseo daemon status`. Run `paseo daemon start` (or `paseo start`) if the daemon is not running.
- Auth errors from the underlying provider → the daemon shells out to the provider's CLI and inherits its env. Make sure the relevant provider auth is in place in the same shell that started the daemon.
- After updating paseo or its providers → `paseo daemon restart` to reload.
