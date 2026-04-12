---
name: google-workspace
description: "Read, create, and edit Google Workspace documents using the `gws` CLI. Use this skill whenever the user mentions Google Docs, shares a docs.google.com URL, references a Google Doc ID, or wants to read/write/create Google documents. Also trigger on 'GDoc', 'gdoc', 'Google Doc', 'gws docs', or any Google Workspace document operation. Will expand to cover Drive, Sheets, Gmail, Calendar, and other GWS services."
user-invocable: false
---

# Google Workspace — `gws` CLI

Unified skill for interacting with Google Workspace services via the `gws` command-line tool.

## CLI overview

All Google Workspace APIs share the same invocation pattern:

```
gws <service> <resource> [sub-resource] <method> [flags]
```

Common flags (available across all services):

| Flag | Purpose |
|------|---------|
| `--params '<JSON>'` | URL / query parameters |
| `--json '<JSON>'` | Request body (POST / PATCH / PUT) |
| `--format <fmt>` | Output: `json` (default), `table`, `yaml`, `csv` |
| `--page-all` | Auto-paginate (NDJSON, one JSON object per line) |
| `--output <path>` | Write binary responses to a file |

Schema introspection — useful when you need to discover available fields or request shapes:

```bash
gws schema docs.documents.get
gws schema docs.documents.batchUpdate --resolve-refs   # expand $ref pointers
```

---

## Google Docs

### Extracting a document ID from a URL

Google Docs URLs look like:

```
https://docs.google.com/document/d/<DOCUMENT_ID>/edit
```

The document ID is the long alphanumeric string between `/d/` and `/edit`.

### Reading a document

#### Raw JSON (full structure with styling metadata)

```bash
gws docs documents get --params '{"documentId": "<DOC_ID>"}'
```

#### Plain text (recommended for most use cases)

Pipe through the bundled extraction script — it strips styling metadata and
preamble lines automatically:

```bash
gws docs documents get --params '{"documentId": "<DOC_ID>"}' | \
  python3 "${CLAUDE_PLUGIN_ROOT}/scripts/extract-doc-text.py"
```

The script detects where the JSON payload starts, so there is no need to
manually skip the `Using keyring backend: ...` line that `gws` sometimes
prints before the JSON.

### Creating a document

```bash
gws docs documents create --json '{"title": "My New Document"}'
```

Returns the created document JSON including the new `documentId`.

### Appending text

The `+write` helper is the simplest way to add content:

```bash
gws docs +write --document <DOC_ID> --text 'Text to append'
```

Text is inserted at the **end** of the document body. For richer edits
(formatting, insertion at a specific position, deletion), use `batchUpdate`.

### Batch updates

For structured edits — insert at a position, delete a range, apply formatting:

```bash
gws docs documents batchUpdate \
  --params '{"documentId": "<DOC_ID>"}' \
  --json '{
    "requests": [
      {
        "insertText": {
          "location": { "index": 1 },
          "text": "Hello, world!\n"
        }
      }
    ]
  }'
```

Run `gws schema docs.documents.batchUpdate --resolve-refs` to explore the
full set of request types (`insertText`, `deleteContentRange`,
`updateTextStyle`, etc.).

### Gotchas

- **Keyring preamble** — `gws` may print `Using keyring backend: ...` to
  stdout before the JSON payload. The bundled `extract-doc-text.py` handles
  this. If piping raw JSON elsewhere, skip the first line with `tail -n +2`.
- **Index math** — document indices are 1-based. The body content starts at
  index 1. Fetch the document first to find correct insertion indices.
- **Large documents** — the `get` response can be sizeable. Prefer the
  plain-text extraction path unless you specifically need the structural or
  styling metadata.

---

## Future services

This skill will expand as new GWS integrations are needed. Each service
follows the same `gws <service> <resource> <method>` pattern. When a service
is added, it gets a new section here (or a `references/<service>.md` file if
the documentation grows large).

Planned:

- **Drive** — `gws drive files list|get|create|update|delete`
- **Sheets** — `gws sheets spreadsheets get|create|batchUpdate`
- **Gmail** — `gws gmail users messages list|get|send`
- **Calendar** — `gws calendar events list|get|insert|update|delete`
