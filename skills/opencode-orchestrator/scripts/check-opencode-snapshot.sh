#!/usr/bin/env bash
set -euo pipefail
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPANION="${OPENCODE_COMPANION:-$SKILLS_DIR/opencode-companion/scripts/opencode-companion.mjs}"
if [ ! -f "$COMPANION" ]; then
  echo "OpenCode Companion script not found. Set OPENCODE_COMPANION or install opencode-companion next to this skill."
  exit 0
fi
{
  echo "[serve]"
  node "$COMPANION" serve status 2>/dev/null || echo "serve status unavailable"
  echo
  echo "[jobs]"
  node "$COMPANION" job list --directory "$DIR" --all 2>/dev/null || echo "no active or recorded jobs for $DIR"
} | sed -n '1,40p'
