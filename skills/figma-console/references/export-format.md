# Frame export format

The bundled `scripts/serialize-selection.js` converts the **currently selected
frame** into a portable read-back, and `scripts/export.py` converts that frame
JSON into deterministic HTML and CSS. Before executing the serializer, select
and re-read the intended frame. If the MCP response's `resultAnalysis.warning`
is non-empty, stop and investigate; it is not an acceptable export
verification. This is a visual handoff format, not a replacement for Figma's
renderer.

## Input

Input may be one root node, an MCP `{"result": ...}` wrapper, or an object
containing a `nodes` array/mapping. Nodes may
nest through `children`; a REST-style entry with `document` is accepted. A
node's geometry can use `absoluteBoundingBox: {x,y,width,height}` or a local
`box: {x,y,width,height}`. Absolute boxes are normalized to the root; local
boxes are accumulated through the parent chain.

The exporter maps common fields: visibility, opacity, solid fills and strokes,
corner radius, DROP_SHADOW/INNER_SHADOW effects, and TEXT characters/style
(family, size, weight, line height, letter spacing, and horizontal alignment).
Unknown fields are ignored with a warning on stderr, never treated as PNG or
prototype data.

## Output and acceptance

```bash
python3 skills/figma-console/scripts/export.py FRAME_JSON \
  [--out-dir DIR] [--html NAME] [--css NAME]
```

The command writes only the named HTML and CSS files (defaults:
`frame.html`/`frame.css`). IDs are stable preorder IDs and include readable
`data-figma-id`, `data-figma-name`, and `data-figma-type` attributes. HTML text
is escaped. Re-running with identical input produces byte-identical output.

Acceptance is: read the changed frame JSON back, capture a screenshot, export,
then compare the HTML/CSS visually or in a browser. The exporter does not
generate PNGs or flows; retain the Bridge screenshot and prototype metadata
separately when those are needed.

The house directory is `frame.json`, `frame.png`, `frame.html`, `frame.css`,
and (only for a real reaction) `flows.json`. Flow records preserve
`sourceNodeId`, `sourceName`, `trigger`, `destinationNodeId`, `navigation`, and
`transition` exactly as returned by the Bridge.
