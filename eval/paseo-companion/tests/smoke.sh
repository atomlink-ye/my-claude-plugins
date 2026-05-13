#!/usr/bin/env bash
# Minimal smoke test for the paseo CLI. Offline-safe — only inspects the
# CLI itself; does not contact a daemon.
set -euo pipefail

if ! command -v paseo >/dev/null 2>&1; then
  echo "SKIP: paseo CLI not on PATH"
  exit 0
fi

if ! paseo --help >/dev/null 2>&1; then
  echo "FAIL: paseo --help failed"
  exit 1
fi

if ! paseo --version >/dev/null 2>&1 && ! paseo version >/dev/null 2>&1; then
  echo "FAIL: paseo --version / version failed"
  exit 1
fi

echo "PASS: paseo-companion smoke"
