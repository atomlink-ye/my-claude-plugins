#!/usr/bin/env bash
# Minimal smoke test for daytona-manager.mjs. Offline-safe — only inspects
# local cached state, never creates or contacts a real sandbox.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "FAIL: daytona-manager missing at ${SCRIPT}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not on PATH"
  exit 0
fi

# `status` reads only the local cached state file; it never hits the Daytona API.
out="$(node "${SCRIPT}" status --directory "${REPO_ROOT}" 2>&1 || true)"
if [[ -z "${out}" ]]; then
  echo "FAIL: daytona-manager status produced no output"
  exit 1
fi

echo "PASS: daytona-companion smoke"
