# Output formats

Paseo's CLI is designed to be machine-readable when needed. The flags below are top-level — they apply to every command unless noted.

## Top-level format flags

| Flag | Meaning |
|---|---|
| `-o, --format <format>` | Output format: `table` (default), `json`, `yaml`. |
| `--json` | Alias for `--format json`. |
| `-q, --quiet` | Minimal output — IDs only. Useful in scripts. |
| `--no-headers` | Omit table headers. |
| `--no-color` | Disable ANSI colors. |

Examples:

```bash
paseo ls --json | jq '.[] | select(.status=="running")'
paseo ls -q                                        # only IDs, one per line
paseo run -d --json "..." | jq -r .id              # capture agent ID for scripting
```

## `--output-schema` — constrain agent output to a JSON schema

`paseo run` accepts `--output-schema <schema>` to require the agent's final output to match a JSON schema. Pass either a file path or an inline schema string.

```bash
paseo run \
  --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' \
  "summarize the diff in this branch"

paseo run --output-schema ./schema.json "..."
```

Notes:

- `--output-schema` blocks until completion. It is **incompatible with `--detach`**.
- The agent is told to return only matching JSON; downstream commands can pipe directly into `jq`.

## `--host <host>` — daemon target

Every command that talks to the daemon accepts `--host <host>`. Without it, the CLI prefers the local socket/pipe and falls back to `localhost:6767`. Most users never set this.

```bash
paseo --host my-remote:6767 ls
paseo run --host localhost:6767 "..."
```
