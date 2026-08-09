---
name: figma-console
description: "Use when the user asks to inspect, diagnose, read, edit, prototype, export, or screenshot a Figma file through the local figma-console-mcp/Desktop Bridge; use it for live Figma canvas work, node geometry, text, components, reactions, flows, or prototype validation."
user-invocable: true
---

# Figma Console

Use this skill for live Figma work. It is a runtime adapter, not a replacement
for Figma's API contract: **schema first, Bridge as live truth**. REST and
hybrid convenience tools can be useful, but may return `429`; retry briefly or
switch to a focused Bridge call rather than assuming a missing node.

The Desktop Bridge reads and writes the state of the Figma desktop app on this
machine. Bridge calls must run locally where Figma is open and authenticated;
do not send a Bridge request to a remote worker or claim that a remote API
session represents the current canvas.

## Runtime workflow

1. Inspect the installed contract before doing anything else:

   ```bash
   mcporter list figma-console-mcp --schema --config ~/.mcporter/mcporter.json
   ```

   Then call `figma_diagnose` and report whether the local Desktop Bridge is
   connected, which file/page is active, and any version or capability drift.
   Tool routing can be hybrid; in particular,
   `figma_get_component_for_development_deep` is explicitly a Desktop Bridge
   path in the current schema.

2. Resolve scope. Prefer an explicit `fileKey` for one file. For several open
   files, use the current-schema commands below, then lock the selected URL:

   ```bash
   mcporter call figma-console-mcp.figma_list_open_files --config ~/.mcporter/mcporter.json
   mcporter call figma-console-mcp.figma_navigate --args '{"url":"https://www.figma.com/design/FILE_KEY/Example","lock":true}' --config ~/.mcporter/mcporter.json
   # Unlock the same URL after the operation:
   mcporter call figma-console-mcp.figma_navigate --args '{"url":"https://www.figma.com/design/FILE_KEY/Example","lock":false}' --config ~/.mcporter/mcporter.json
   ```

   Keep the lock narrow; do not infer the current file from a stale tab title.

3. Read before writing: locate the page/node, fetch the smallest useful tree,
   and capture the current value. For complex JSON always pass one quoted
   argument, for example:

   ```bash
   mcporter call figma-console-mcp.figma_execute --args '{"code":"return figma.currentPage.selection.map(n => ({id:n.id,name:n.name}))"}' --config ~/.mcporter/mcporter.json
   ```

   `figma_execute` defaults to a 5000 ms timeout and accepts at most 30000 ms
   in the current local schema. Keep scripts small and deterministic.

4. Before any text write, await `figma.loadFontAsync` for every font/style the
   text node will use. Do not rely on a font merely being present in the
   inspector. For prototype reactions use the current `actions` shape; verify
   the target node and trigger in the returned object.

5. After writing, read the changed nodes back and run
   `figma_capture_screenshot`. Use `--save-images <directory>` for image
   outputs when invoking mcporter. A successful mutation without a read-back
   and screenshot is incomplete; mention any stale render or session-only
   observation explicitly.

6. For a portable artifact, save a frame JSON read-back and run the bundled
   exporter:

   ```bash
   python3 skills/figma-console/scripts/export.py frame.json --out-dir out
   ```

   The exporter emits deterministic HTML/CSS only. It does not fabricate PNGs
   or prototype flows. See the linked references for the data and acceptance
   details.

   For the current selection, use `scripts/serialize-selection.js` as the
   `code` value with a 30000 ms timeout, pass the quoted JSON through
   `--args`, and retain the MCP `--output json` wrapper as `frame.json`; the
   exporter unwraps a top-level `result`. In mcporter 0.9.0, `--args` must be
   quoted JSON; inspect `mcporter --help` before relying on newer stdin forms.

## Reference routing

- [data-paths.md](references/data-paths.md): Bridge/REST/hybrid boundaries,
  rate limits, diagnosis, and version drift.
- [editing-and-prototyping.md](references/editing-and-prototyping.md): execute
  scripts, fonts, text, reactions, Smart Animate, and session observations.
- [export-format.md](references/export-format.md): frame JSON shape, stable
  HTML/CSS output, screenshot/read-back acceptance, and CLI usage.
- [mcporter.md](references/mcporter.md): current quoted-JSON argument form and
  version-aware CLI guidance.

If a reference conflicts with the installed schema, the schema wins; record the
observed version and update the local run notes rather than guessing.
