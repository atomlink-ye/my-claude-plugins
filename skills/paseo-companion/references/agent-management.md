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

## Self-identification

`paseo inspect <id> --json` doubles as a way to confirm an ID actually refers to *your own* running session — check Provider/Model/Status/Cwd against what you know about yourself before targeting an ID for self-directed operations (e.g. self-messaging, self-compact — see `references/chat-and-permit.md`).

## Don't trust an agent's self-report of delegation

An agent's own narrative ("confirmed: I used a sub-agent for X") is not proof on its own. Cross-check against records Paseo actually tracks:

- `paseo inspect <id> --json` returns `ParentAgentId` — Paseo tracks manager→runtime parentage, so a claimed dispatch should show up as a real parent/child relationship between agent IDs.
- The Paseo GUI renders structured sub-steps (e.g. a `Sub Agent` step nested inside a tool-call card) that are daemon-recorded events, not model-written text — their presence is trustworthy signal even if the flattened CLI view doesn't preserve the same structure.
- `paseo logs <id>` can flatten nested tool-call structure into plain lines that look like unstructured narrative. A missing structural marker in `paseo logs` output is not proof a delegation didn't happen — check `inspect --json` or the GUI before concluding that.

## Reading prompts from files

`paseo send` accepts `--prompt-file <path>` for prompts too long, multi-line, or escape-heavy to pass as a CLI argument. The file is read as UTF-8.
