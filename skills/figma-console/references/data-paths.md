# Figma data paths

## Choose the path from the schema

Run `mcporter list figma-console-mcp --schema --config
~/.mcporter/mcporter.json` at the start of a session. The installed schema is
the source of truth for names, argument shape, and timeout limits.

- **Desktop Bridge**: local, live Figma desktop state. Use it for the active
  page, selection, node inspection, mutations, and screenshot capture. The
  process must be on the same machine as the open Figma app.
- **REST**: file/document convenience reads where a token and a stable
  `fileKey` are appropriate. REST data can lag the desktop canvas and is
  subject to service throttling.
- **Hybrid/convenience tools**: route internally according to the current
  schema. Treat the result as useful evidence, then confirm live state with a
  Bridge read when editing or validating. The current schema marks
  `figma_get_component_for_development_deep` as Desktop Bridge.

Do not copy a fixed REST/Bridge tool table from an old handoff. Tool routing and
names can drift between installations.

## Limits and diagnosis

REST or hybrid calls may return HTTP `429` (rate limit). Back off briefly,
narrow the request, or use a local Bridge read; a 429 is not evidence that a
node or file is absent. Avoid parallel broad tree reads.

`figma_diagnose` is the first health check after schema inspection. Save its
server version/mode, connection status, active file/page, and REST-token state
alongside an issue. Capabilities come from the schema output, not from the
diagnostic JSON. If a call worked yesterday but a field or tool is now absent,
treat that as version drift and re-read the schema before changing code.

Use `fileKey` for deterministic targeting. If working across multiple files,
list them and lock the selected file when the schema offers locking; otherwise
never infer the current file from a stale tab title.
