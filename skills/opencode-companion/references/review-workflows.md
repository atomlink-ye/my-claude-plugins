# Review Workflows

The old `/opencode:review` and `/opencode:adversarial-review` command wrappers are replaced by the direct `review` verb.

## Working tree review

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" review \
  --directory "$WORK_DIR" \
  --scope working-tree \
  --wait
```

## Branch adversarial review

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs" review \
  --directory "$WORK_DIR" \
  --adversarial \
  --scope branch \
  --base "$BASE_REF" \
  --wait
```

Use a fresh session for independent review unless the explicit goal is to continue an existing review thread.

Treat Critical/High findings as blockers unless the user accepts them. Preserve review stdout and finding text exactly when forwarding results.
