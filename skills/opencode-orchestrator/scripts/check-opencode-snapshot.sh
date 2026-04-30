#!/usr/bin/env bash
set -euo pipefail
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Prefer the standalone agent-skill install when present; fall back to the
# marketplace skill-local script. The old plugins/opencode/... path was removed.
COMPANION="${OPENCODE_COMPANION:-$HOME/.agents/skills/opencode-companion/scripts/opencode-companion.mjs}"
if [ ! -f "$COMPANION" ]; then
  COMPANION="$HOME/.claude/plugins/marketplaces/my-claude-plugins/skills/opencode-companion/scripts/opencode-companion.mjs"
fi
if [ ! -f "$COMPANION" ]; then
  echo "OpenCode companion not found at standalone or marketplace skill-local paths"
  exit 0
fi
{
  echo "[serve]"
  node "$COMPANION" serve status 2>/dev/null || echo "serve status unavailable"
  echo
  echo "[jobs]"
  node "$COMPANION" job list --directory "$DIR" --all 2>/dev/null || echo "no active or recorded jobs for $DIR"
} | sed -n '1,40p'
