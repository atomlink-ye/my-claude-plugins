# Cube Sandbox adapter details

Cube Sandbox uses the E2B-compatible JavaScript SDK against a network-reachable
operator API endpoint. The control plane needs an API endpoint and API key from
`CUBE_API_URL`/`CUBE_API_KEY` (or the upstream SDK names `E2B_API_URL`/
`E2B_API_KEY`). Credentials can be imported into the per-user global config with
`sandbox-ctl --adapter cube-sandbox config set`; project
`.sandbox-ctl/config.json` remains secret-free. `config status` reports only
booleans, sanitized URLs, and the config path. `config path` prints the path.
The default is `~/Library/Application Support/sandbox-ctl/config.json` on macOS,
`$XDG_CONFIG_HOME/sandbox-ctl/config.json` when set, and `~/.config/sandbox-ctl/config.json`
otherwise; `SANDBOX_CTL_USER_CONFIG` overrides it.

For a fixed scheduler node, configure the separate SSH fallback with
`CUBE_SCHEDULER_SSH_HOST`, `CUBE_SCHEDULER_CLI_PATH`, and optionally
`CUBE_SCHEDULER_NODES='{"daytona":"10.77.0.1"}'`, then run
`sandbox-ctl --adapter cube-sandbox config set`. These values are stored under
`adapters.cube-sandbox.scheduler` as `sshHost`, `cliPath`, and `nodes`.
`up --node NODE_OR_ALIAS --template TEMPLATE_ID` resolves a configured alias
or accepts a bare IP, then uses argv-based local `ssh` with a remote temporary
directory. The render output is not persisted in the project or printed:
only `.api_request` is passed to
`multirun --norm --printall --fail_exit --async_retry_max 0 --hostid ...`.
The command fails closed unless the strict success counters and non-empty
sandbox ID are all present, and it does not create a binding on failure.
`--node` is Cube `up`-only; Daytona and other commands reject it.
Node mode is new-binding-only when the selected project already has a
binding; pass a distinct `--name` to create a separate binding explicitly.

Each field resolves independently as `CUBE_*` environment value, then global
config, then the corresponding `E2B_*` value. Stored config files are mode 0600
inside a mode 0700 directory and are written atomically. A configured `caPath`
is applied to Node's runtime CA set when supported (and passed through as
`CUBE_CA_PATH`); otherwise start Node with `NODE_EXTRA_CA_CERTS`.

The data plane is CubeProxy. No SSH session or tunnel is required by
`sandbox-ctl`; operators must provide a network-reachable endpoint. Preview
URLs use the SDK's `getHost(port)` result and therefore require the target
domain's DNS/TLS/proxy wiring. For E2B JS transport in production, use
wildcard DNS and TLS, or the official development-sidecar fallback.

For a fixed self-hosted node, set `CUBE_API_NODE_IP` and
`CUBE_PROXY_NODE_IP` (plus `CUBE_PROXY_PORT_HTTPS` when it is not 443).
`sandbox-ctl` starts a per-user local daemon and a strict loopback proxy that
direct-dials those IPs while preserving the API/sandbox Host and TLS SNI. It
does not read SSH config or server credentials. `sandbox-ctl daemon
start|status|stop` manages this process; `exec` starts it automatically.
Changing connection settings or rotating the API key requires a daemon
restart and is detected by a non-secret fingerprint.

New directories default to Cube Sandbox. An existing project config remains
authoritative; legacy configs without an adapter continue to mean Daytona.

## Templates and timeouts

`up` has no built-in template default that works here: the upstream SDK falls
back to a template literally named `base`, which does not exist on our operator
node and fails with CubeMaster `130404`. **Always pass `--template`.** The node
exposes no template-listing command; query the API's `/templates` endpoint.

`up` uses a 30-minute sandbox idle timeout unless overridden with `--timeout`;
`exec` has an independent 5-minute local wait default. `adopt` accepts the same
`--timeout` duration, defaults to 30 minutes when omitted, and applies it via
the connected sandbox instance's `setTimeout` before persisting the binding. If
that capability is unavailable, adoption fails instead of claiming the timeout
was changed. Idle expiry **kills** the sandbox — unlike Daytona there is no
separate stop/archive/delete ladder and no `--auto-delete -1` — so size the
timeout to the work and pull artifacts before it expires.

Cube workspace ownership is opt-in with `--workspace-owner UID:GID` (for
example `1000:1000`); UID and GID must be non-root positive integers. `up`
provisions the exact workspace root with that owner and refuses a non-empty
existing root whose owner differs, rather than recursively changing ownership.
It also checks every existing descendant for the same numeric owner and fails
closed on mixed ownership; no recursive repair is attempted.
The owner is stored in the binding. Bundle/full pushes normalize archive
numeric ownership, preserve the provisioned workspace root metadata during
extraction, and chown only an uploaded single file. Git push is refused when
an owner contract is active; use bundle or full mode for that workspace.

## Exec failures and workspace ownership

Streaming and JSON `exec` preserve the remote command's actual exit code. If
the local daemon or its proxy transport is unavailable, `exec` returns control
exit 125 and writes an actionable diagnostic to stderr. Restart only the local
path with `sandbox-ctl daemon stop && sandbox-ctl daemon start`, then retry.

If a local CLI client times out or disconnects during a long `exec`, a later
daemon write can target the dead Unix socket and produce `EPIPE`/`ECONNRESET`.
The daemon consumes that connection-level error so it remains available for
other clients; the interrupted command is not resumed, and the client still
receives a control failure.

Workspace-owner contract failures are reported as an ownership mismatch, not a
network or fetch failure. The check remains fail-closed and never recursively
repairs ownership.

`--workspace-owner` refuses a non-empty root with a different owner
(`exit 78: workspace is non-empty and owned by 0:0`). That is the documented
fail-closed behavior, not a bug: `chown -R UID:GID` the workspace explicitly
first, then run `up --workspace-owner`. Retrying the same `up` will never work.

If ownership has intentionally changed, migrate it explicitly before retrying;
`up --workspace-owner` with a non-empty wrong-owned directory continues to
return exit 78.

## Experimental lifecycle commands

`sandbox-ctl pause` and `sandbox-ctl resume` are experimental command
interfaces, not a default workflow. In the 2026-08-11 canary, pause remained
in `pausing` and then returned 408; native recovery followed by a fresh
connection failed during fetch. Complete state recovery and a stable data
plane were not established, so these commands must not be an A/B prerequisite.
The implementation requests `Sandbox.pause` with `keepMemory: true`, applies
the binding ownership checks, and invalidates cached connections before a
resume attempt, but this is an implementation description rather than a
success guarantee. `down` remains the delete operation.
When lifecycle recovery is available, the binding's idle timeout is retained
across reconnects and a repeated resume of an already-running sandbox skips a
second control-plane connect; these behaviors are not evidence that the
experimental data plane is stable.
`status` and `list` pass through the control-plane `state` (including
`paused`); status does not use a connect merely to determine state. Cube `list`
also returns the API-provided lifecycle timing fields `startedAt` and `endAt`
alongside each item's `id`, `name`, and `template`. `list.state` is
control-plane metadata, not a data-plane liveness check; a successful `exec`
is the liveness check for the command path.
If lifecycle control reports an incompatible local daemon protocol, restart
only the local daemon (`sandbox-ctl daemon stop` followed by `daemon start`)
before retrying; this does not restart the Cube sandbox service.

Automatic idle pause/resume is intentionally not supported yet. e2b SDK
2.38.2 serializes `autoPause`/`autoResume` as top-level options, while Cube
v0.6 expects those settings under a nested `lifecycle` object; do not pass the
flags because they would not take effect. Daytona reports pause/resume as
unsupported rather than routing either command to `down`.

`cube` is retained only as a deprecated CLI/config compatibility spelling and
is normalized to the canonical machine ID `cube-sandbox` and human name
`Cube Sandbox` on read/write.
