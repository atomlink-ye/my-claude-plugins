# Loops and schedules

Two distinct iteration primitives: **loops** repeat a worker/verifier cycle until done; **schedules** fire a prompt at a cron or interval cadence.

## Loops

A loop launches a worker agent, then verifies its output, then repeats until verification succeeds or limits are hit.

### `paseo loop run "<prompt>"` — start a loop

```bash
paseo loop run "<worker prompt>" [options]
```

| Option | Meaning |
|---|---|
| `--verify "<prompt>"` | Verifier agent prompt. Asked to judge whether the worker is done. |
| `--verify-check "<command>"` | Shell command that must exit 0 to pass. Repeatable; all checks must pass. |
| `--name <name>` | Display name for the loop. |
| `--sleep <duration>` | Pause between iterations (e.g. `30s`, `5m`). |
| `--max-iterations <n>` | Stop after N iterations. |
| `--max-time <duration>` | Stop after total wall-clock duration (e.g. `1h`, `30m`). |
| `--provider <provider[/model]>` | Worker provider/model. |
| `--model <model>` | Worker model when not encoded in `--provider`. |
| `--verify-provider <provider[/model]>` | Verifier provider/model. |
| `--verify-model <model>` | Verifier model. |
| `--archive` | Archive worker and verifier agents after each iteration (preserves history). |
| `--json` | JSON output. |
| `--host <host>` | Daemon host target. |

A loop needs **at least one** form of verification — either `--verify "<prompt>"` or one or more `--verify-check`. Both can combine: shell checks run first, then the verifier prompt.

### Managing loops

```bash
paseo loop ls                  # list all loops
paseo loop inspect <id>        # show details and iteration history
paseo loop logs <id>           # stream logs
paseo loop stop <id>           # stop a running loop
```

## Schedules

A schedule fires a prompt at a cron or interval cadence — useful for monitoring, periodic sweeps, or recurring tasks.

### `paseo schedule create "<prompt>"` — create a schedule

```bash
paseo schedule create "<prompt>" [options]
```

| Option | Meaning |
|---|---|
| `--every <duration>` | Fixed interval cadence (e.g. `5m`, `1h`). |
| `--cron <expr>` | Cron expression cadence. |
| `--name <name>` | Display name. |
| `--target <self\|new-agent\|agent-id>` | Where the prompt runs. `self` = the schedule's own agent, `new-agent` = fresh agent each fire, `<agent-id>` = always send to that agent. |
| `--provider <provider[/model]>` | Provider/model when target is a new agent. |
| `--max-runs <n>` | Stop after N total runs. |
| `--expires-in <duration>` | Time-to-live for the schedule. |
| `--json` | JSON output. |
| `--host <host>` | Daemon host target. |

Pass exactly one of `--every` or `--cron`.

### Managing schedules

```bash
paseo schedule ls              # list schedules
paseo schedule inspect <id>    # show details
paseo schedule logs <id>       # recent run logs
paseo schedule pause <id>      # pause a schedule
paseo schedule resume <id>     # resume a paused schedule
paseo schedule delete <id>     # delete a schedule
```

## When to pick which

- Use a **loop** when the work is "do this until it's right" — finite, verification-driven.
- Use a **schedule** when the work is "do this every N" — recurring, time-driven.
