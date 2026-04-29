# Terminals

Paseo terminals are persistent tmux-like shells managed by the daemon. They survive the calling shell, can be inspected and steered remotely, and are useful for hosting long-running interactive processes.

## `paseo terminal create` — create a terminal

```bash
paseo terminal create
paseo terminal create --cwd ~/dev/myapp
paseo terminal create --name "build-runner"
paseo terminal create --json                 # capture the terminal ID
```

## `paseo terminal ls` — list terminals

```bash
paseo terminal ls                # terminals in current directory (default scope)
paseo terminal ls --json
```

## `paseo terminal kill <id>` — destroy a terminal

```bash
paseo terminal kill <id>
paseo terminal kill abc123       # ID prefix
paseo terminal kill build-runner # by name
```

## `paseo terminal capture <id>` — read terminal output

```bash
paseo terminal capture <id>                    # visible pane, ANSI stripped
paseo terminal capture <id> -S                 # full scrollback + visible
paseo terminal capture <id> --start 0 --end 10 # line range (tmux-style)
paseo terminal capture <id> --start -5         # last 5 lines
paseo terminal capture <id> --ansi             # preserve ANSI escape codes
paseo terminal capture <id> --json             # output with metadata
```

## `paseo terminal send-keys <id> <keys...>` — send keystrokes

```bash
paseo terminal send-keys <id> "ls -la" Enter
paseo terminal send-keys <id> "echo hello" Enter
paseo terminal send-keys <id> C-c                       # Ctrl+C
paseo terminal send-keys <id> --literal "raw text"      # no token interpretation
```

### Special key tokens

Interpreted unless `--literal` is set:

`Enter`, `Tab`, `Escape`, `Space`, `BSpace`, `C-c`, `C-d`, `C-z`, `C-l`, `C-a`, `C-e`

## Common pattern — run a process and interact with it

```bash
id=$(paseo terminal create --name "my-shell" -q)
paseo terminal send-keys "$id" "some-tool" Enter
paseo terminal capture "$id" --scrollback   # see what happened
paseo terminal send-keys "$id" "command" Enter
paseo terminal capture "$id" --scrollback   # see the response
paseo terminal send-keys "$id" "exit" Enter
paseo terminal kill "$id"
```
