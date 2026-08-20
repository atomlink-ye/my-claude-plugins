#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  echo "usage: setup.sh" >&2
  exit 2
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$script_dir/../../.." && pwd)

if ! command -v pnpm >/dev/null 2>&1; then
  echo "agent-memory setup requires pnpm to install the repository CLI link" >&2
  exit 1
fi

# Re-linking is safe and makes the command resolve to this checkout after pulls.
pnpm --dir "$repo_root" link --global >/dev/null

if ! command -v agent-memory >/dev/null 2>&1; then
  echo "agent-memory was linked but is not on PATH; add pnpm's global bin directory to PATH" >&2
  exit 1
fi

# init is intentionally non-destructive: an existing user registry is preserved.
if ! agent-memory --json status >/dev/null 2>&1; then
  agent-memory --json init >/dev/null
fi

agent-memory --json status
