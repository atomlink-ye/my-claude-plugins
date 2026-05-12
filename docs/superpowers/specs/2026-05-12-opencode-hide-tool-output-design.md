# OpenCode Companion hide tool output design

## Goal

Remove `tool output` from the human-readable OpenCode Companion trace rendering so logs stay compact and readable while preserving the underlying raw session data and logs.

## Scope

This change applies to the display layer in `skills/opencode-companion/scripts/opencode-companion.mjs`.

Included:
- session/status trace rendering
- live tool event rendering during session streaming
- unit tests covering trace text

Excluded:
- raw OpenCode session/message payloads
- persisted logs and artifacts
- usage/token reporting

## Design

### Rendering behavior

`buildToolTraceEntry()` will stop appending `output: ...` lines to `detailLines`.

Because both the session/status view and the live event printer already route tool summaries through `buildToolTraceEntry()`, removing the rendered output there gives one consistent behavior across both surfaces.

### Data preservation

The implementation will not delete or mutate `part.state.output`, `part.output`, or any other raw tool payload fields. The raw data remains available to other code paths and future debugging workflows. Only the summary text shown to humans changes.

### Remaining detail lines

The rendered tool trace should continue to show:
- `command`
- `description`
- `subagent`
- `input`
- `exit`
- `sessions`

This keeps logs useful for understanding what ran and whether it completed, without dumping long command output into the summary.

## Risks and mitigations

- Risk: someone relied on `output:` in status snapshots.
  - Mitigation: update tests to lock in the new compact format and keep raw logs unchanged.
- Risk: live event rendering diverges from session/status rendering.
  - Mitigation: keep both paths shared through the same trace entry builder.

## Testing

- Update unit tests in `eval/opencode/tests/unit/render.test.mjs` to assert that tool output is not rendered.
- Keep coverage that command/input/other trace fields still render.
- Run the targeted render test file.
- Run a real OpenCode Companion task in `/tmp` and inspect the human-readable output to confirm `output:` is gone while logs remain readable.
