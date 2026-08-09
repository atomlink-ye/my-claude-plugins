# figma-console

`figma-console` is a local-runtime skill for inspecting, editing, prototyping,
and exporting the Figma file currently open in the desktop app. It keeps the
installed MCP schema and Desktop Bridge as the live source of truth, then
offers a small deterministic HTML/CSS handoff exporter.

## Before you start

- Figma Desktop must be open on the same machine as the MCP call, with the
  Desktop Bridge connected and the intended file selected.
- `mcporter` and `~/.mcporter/mcporter.json` must be available locally.
- For text changes, the bridge session must be able to load the requested font.

The skill is useful when the task needs live canvas state, exact node IDs,
screenshots, or a verified mutation. Use direct MCP instead when you already
have a stable schema and only need one non-Figma operation; use the skill when
you need its diagnosis/read-before-write/read-back workflow.

## Short worked example

From the plugin checkout, the flow is:

```bash
# 1. Inspect the installed contract and diagnose the local bridge.
mcporter list figma-console-mcp --schema --config ~/.mcporter/mcporter.json
mcporter call figma-console-mcp.figma_diagnose --config ~/.mcporter/mcporter.json

# 2. List open files, lock the selected URL, then execute a focused read.
mkdir -p ./out
mcporter call figma-console-mcp.figma_list_open_files --config ~/.mcporter/mcporter.json
mcporter call figma-console-mcp.figma_navigate \
  --args '{"url":"https://www.figma.com/design/FILE_KEY/Example","lock":true}' \
  --config ~/.mcporter/mcporter.json
figma_args="$(python3 -c 'import json,sys; print(json.dumps({"code":open(sys.argv[1], encoding="utf-8").read(), "timeout":30000}))' skills/figma-console/scripts/serialize-selection.js)"
mcporter call figma-console-mcp.figma_execute --args "$figma_args" --output json \
  --config ~/.mcporter/mcporter.json > ./out/frame.json

# 3. Capture the same frame for visual acceptance.
SELECTION_ID="$(python3 -c 'import json; p=json.load(open("./out/frame.json")); n=p.get("result",p); print(n.get("id", ""))')"
mcporter call figma-console-mcp.figma_capture_screenshot \
  --args "{\"nodeId\":\"$SELECTION_ID\"}" --save-images ./out \
  --config ~/.mcporter/mcporter.json

# 4. Generate a deterministic handoff (HTML/CSS only).
python3 skills/figma-console/scripts/export.py ./out/frame.json --out-dir ./out

# 5. Open out/frame.html, compare it with the saved screenshot, and confirm
#    the node read-back before reporting completion. Unlock the same URL:
mcporter call figma-console-mcp.figma_navigate \
  --args '{"url":"https://www.figma.com/design/FILE_KEY/Example","lock":false}' \
  --config ~/.mcporter/mcporter.json
```

The exact lock, read, and screenshot argument names come from the schema you
just inspected. Do not paste secrets into commands or this document. See the
skill references for path selection, text/prototype editing, and export field
coverage.

For the three-page plan cap, cross-page helper, and stale cloned-TEXT workaround,
use the single source of truth in
[editing-and-prototyping.md](../skills/figma-console/references/editing-and-prototyping.md).

The house tree is `frame.json` (read-back), `frame.png` (Bridge screenshot),
`frame.html` and `frame.css` (the bundled exporter), plus `flows.json` only
when a real reaction exists. Each flow record uses `sourceNodeId`, `sourceName`, `trigger`,
`destinationNodeId`, `navigation`, and `transition`; preserve the exact values
read from the Bridge.
