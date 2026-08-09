# mcporter invocation details

The installed mcporter 0.9.0 accepts complex arguments as one quoted JSON
value:

```bash
mcporter call figma-console-mcp.figma_execute \
  --args '{"code":"return figma.currentPage.selection.length","timeout":5000}' \
  --output json --config ~/.mcporter/mcporter.json
```

Keep `--config` on every call. Before relying on a newer stdin or argument
form, inspect `mcporter --help` and the server schema; this reference records
the current local behavior, not a promise about future versions.
