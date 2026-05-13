#!/usr/bin/env bash
# Minimal smoke test for the opencode-companion script.
# Runs offline-safe commands only:
#   - script reachable
#   - `serve status` parses (does not start a serve if none is running)
#
# Exit 0 = smoke pass. Non-zero = something is structurally broken.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/skills/opencode-companion/scripts/opencode-companion.mjs"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "FAIL: companion script missing at ${SCRIPT}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not on PATH"
  exit 0
fi

# `serve status` is read-only and prints something even when no serve runs.
if ! node "${SCRIPT}" serve status >/dev/null 2>&1; then
  # serve status may exit non-zero when nothing is running; that's still a
  # successful structural smoke as long as the script ran. Re-run capturing
  # stderr to confirm it produced output.
  out="$(node "${SCRIPT}" serve status 2>&1 || true)"
  if [[ -z "${out}" ]]; then
    echo "FAIL: opencode-companion serve status produced no output"
    exit 1
  fi
fi

echo "PASS: opencode-companion smoke"
