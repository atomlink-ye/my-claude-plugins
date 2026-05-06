# Daytona Companion Troubleshooting

## SDK unavailable

Install `@daytona/sdk` where the manager script can resolve it. `--help` and local-only `status` should not require network access.

## Status is stale

By default, `status` reads the global project-scoped state file under `~/.daytona/claude-code/projects/`. Use `--refresh` only when you intentionally want a Daytona SDK/network call.

## Secrets appear in output

Stop and treat this as a bug. Status output must redact secret values and summaries must not print `.env.local` contents.

## Remote command quoting

Pass remote commands after `--`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" exec --directory "$WORK_DIR" -- pnpm test
```

Do not interpolate raw user command strings into shell substitutions.

## State is in the wrong place

Move state under `~/.daytona/claude-code/projects/` or pass `--state-directory DIR` for explicit isolation. Never persist runtime state in the marketplace, plugin, skill source tree, or new project-local `.daytona/` files.

## Remote workspace path is wrong

Some sandbox images use `/workspace`, while `up` may reset the companion state to a relative path such as `workspace/<task-id>`. If `exec`, `push`, or `pull` resolves paths under the wrong remote home, adopt the sandbox with the actual workspace path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" adopt \
  --directory "$WORK_DIR" \
  --task-id "$TASK_ID" \
  --sandbox-id "$SANDBOX_ID" \
  --remote-path "/workspace"
```

## Remote daemon stale after sandbox restart

After a sandbox restart, remote daemon state can point at old PIDs. Restart remote Paseo and OpenCode serve from the sandbox:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'paseo daemon stop || true; PASEO_DAEMON_LISTEN=0.0.0.0:6767 paseo daemon start --listen 0.0.0.0:6767 --hostnames true --no-relay'

node "${CLAUDE_PLUGIN_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs" exec --directory "$WORK_DIR" --cwd "/workspace" -- \
  sh -lc 'node /home/dev/.agents/skills/opencode-companion/scripts/opencode-companion.mjs serve start'
```

## Remote agents are invisible locally

If agents were launched by `daytona exec ... paseo run ...`, they are attached only to the sandbox-local daemon. Prefer the remote runtime workflow:

1. Start Paseo inside the sandbox on `0.0.0.0:6767`.
2. Open a Daytona preview for port `6767`.
3. Strip the preview URL to `host:port`.
4. Launch from local with `paseo run --host "$REMOTE_PASEO_HOST" ...`.

See `remote-agent-runtime.md`.
