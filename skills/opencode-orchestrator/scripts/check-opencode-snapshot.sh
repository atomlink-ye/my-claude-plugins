#!/usr/bin/env bash
set -euo pipefail
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
COMPANION="$HOME/.claude/plugins/marketplaces/my-claude-plugins/plugins/opencode/scripts/opencode-companion.mjs"
if [ ! -f "$COMPANION" ]; then
  echo "OpenCode companion not found at $COMPANION"
  exit 0
fi
{
  echo "[serve]"
  node "$COMPANION" check --directory "$DIR" 2>/dev/null || echo "check unavailable for $DIR"
  echo
  echo "[jobs]"
  node "$COMPANION" status --directory "$DIR" 2>/dev/null || echo "no active or recorded jobs for $DIR"
} | sed -n '1,40p'
