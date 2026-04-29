# Agent management

Commands beyond the common-path `run / send / ls / wait / logs / attach`. The agent ID accepts a unique prefix or the agent's name, not just the full UUID.

## `paseo inspect <id>` — show agent details

```bash
paseo inspect <id>
paseo inspect <id> --json
```

Returns metadata: provider, model, status, working directory, labels, tokens, cost, timestamps.

## `paseo stop [id]` — interrupt a running agent

```bash
paseo stop <id>
paseo stop --all                # stop every agent
paseo stop --cwd <path>         # stop every agent in a directory
```

No-op against an idle agent. Stop interrupts the current run; the agent remains, and you can `send` to it again.

## `paseo archive <id>` — soft-delete

```bash
paseo archive <id>
paseo archive <id> --force      # interrupt running agent first, then archive
```

Removes the agent from default `ls` output but keeps history. List archived agents with `paseo ls -a`.

## `paseo delete [id]` — hard-delete

```bash
paseo delete <id>
paseo delete --all
paseo delete --cwd <path>
```

Interrupts the agent if running, then removes it permanently.

## `paseo agent <subcmd>` — advanced operations

`paseo agent` mirrors the top-level commands and adds three:

| Subcommand | Purpose |
|---|---|
| `paseo agent mode <id> [mode]` | Change operational mode. `--list` prints available modes for that agent's provider. |
| `paseo agent reload <id>` | Restart the underlying agent process (preserves history). |
| `paseo agent update <id>` | Update metadata. Flags: `--name <name>`, `--label <key=value>` (repeatable). |

Examples:
```bash
paseo agent mode <id> --list
paseo agent mode <id> bypass
paseo agent update <id> --name "auth-rewrite" --label area=backend --label priority=high
paseo agent reload <id>
```

## Labels

Labels are arbitrary `key=value` tags attached at creation (`paseo run --label key=value`) or after the fact (`paseo agent update <id> --label key=value`). `paseo ls --label key=value` filters; repeat to AND-filter.

## Image attachments on `run` and `send`

```bash
paseo run --image screenshot.png "..."
paseo run --image one.png --image two.png "..."
paseo send <id> --image screenshot.png "..."
```

## Reading prompts from files

`paseo send` accepts `--prompt-file <path>` for prompts too long, multi-line, or escape-heavy to pass as a CLI argument. The file is read as UTF-8.
