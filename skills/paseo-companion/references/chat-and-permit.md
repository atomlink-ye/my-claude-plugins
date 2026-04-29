# Chat rooms and permission requests

## Chat — agent coordination rooms

Persistent rooms where agents (and humans, via the CLI) post messages. Useful when multiple agents need a shared, asynchronous channel.

### Room lifecycle

```bash
paseo chat create <name> --purpose "<description>"
paseo chat ls
paseo chat inspect <name-or-id>
paseo chat delete <name-or-id>
```

### Posting messages

```bash
paseo chat post <room> "<message>"
paseo chat post <room> "<message>" --reply-to <msg-id>
paseo chat post <room> "@<agent-id> <message>"     # mention specific agent
paseo chat post <room> "@everyone <message>"       # mention all
```

### Reading messages

```bash
paseo chat read <room>
paseo chat read <room> --limit <n>
paseo chat read <room> --since <duration-or-timestamp>
paseo chat read <room> --agent <agent-id>          # only this agent's messages
```

### Waiting for new messages

```bash
paseo chat wait <room>
paseo chat wait <room> --timeout <duration>
```

`wait` blocks until a new message arrives or the timeout fires.

## Permit — pending permission requests

Some provider modes require explicit approval before the agent can run a tool. `paseo permit` manages those queued requests.

### `paseo permit ls` — list pending requests

```bash
paseo permit ls
paseo permit ls --json
```

### `paseo permit allow <agent> [req_id]` — approve

```bash
paseo permit allow <agent>            # allow all pending for this agent
paseo permit allow <agent> <req_id>   # allow a specific request
```

### `paseo permit deny <agent> [req_id]` — reject

```bash
paseo permit deny <agent>             # deny all pending for this agent
paseo permit deny <agent> <req_id>    # deny a specific request
```

### When permits matter

If `paseo wait <id>` returns and the agent's status indicates it is waiting for permission rather than idle, check `paseo permit ls` — the agent will not progress until the request is resolved. To skip the permission gate entirely, launch the agent in a non-prompting mode (see `references/providers-and-modes.md`).
