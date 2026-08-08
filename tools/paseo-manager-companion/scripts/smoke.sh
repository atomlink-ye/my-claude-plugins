#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-18787}"
export PORT
export PASEO_AGENT_ID="${PASEO_AGENT_ID:?Set PASEO_AGENT_ID to the running manager agent id}"
export PASEO_PROVIDER="${PASEO_PROVIDER:-codex}"
export PASEO_MODEL="${PASEO_MODEL:-}"
export PASEO_CWD="${PASEO_CWD:-$PWD}"
LOG="${TMPDIR:-/tmp}/paseo-manager-companion.$$.log"
DATA="${TMPDIR:-/tmp}/paseo-manager-companion.$$.data"
OUT="${TMPDIR:-/tmp}/paseo-companion-smoke.$$"
COMPACT_ID=""
mkdir -p "$DATA"
cleanup() {
  if [[ -n "$COMPACT_ID" && -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    curl -sS -X DELETE "http://127.0.0.1:$PORT/reminders/$COMPACT_ID" \
      -H 'content-type: application/json' -d '{"reason":"smoke cleanup"}' >/dev/null 2>&1 || true
  fi
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -rf "$DATA" "$OUT"
}
trap cleanup EXIT

PASEO_COMPANION_DATA="$DATA" node "$ROOT/dist/server.js" >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done

check() {
  expected="$1"; shift
  code="$(curl -sS -o "$OUT" -w '%{http_code}' "$@")"
  printf 'HTTP %s (expected %s) %s\n' "$code" "$expected" "$*"
  [[ "$code" == "$expected" ]]
}

check 200 "http://127.0.0.1:$PORT/health"
check 201 -X POST "http://127.0.0.1:$PORT/spawn" -H 'content-type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({provider:process.env.PASEO_PROVIDER, ...(process.env.PASEO_MODEL?{model:process.env.PASEO_MODEL}:{}), title:"companion-smoke", cwd:process.env.PASEO_CWD, prompt:"smoke child"}))')"
CHILD="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); const j=JSON.parse(x); console.log(j.id||j.agentId)' "$OUT")"
check 200 "http://127.0.0.1:$PORT/children?agentId=$PASEO_AGENT_ID"
check 200 "http://127.0.0.1:$PORT/children/$CHILD/briefing"
check 201 -X POST "http://127.0.0.1:$PORT/reminders" -H 'content-type: application/json' -d "{\"agentId\":\"$PASEO_AGENT_ID\",\"delaySeconds\":300,\"message\":\"smoke reminder\"}"
REMINDER="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x).id)' "$OUT")"
check 200 -X DELETE "http://127.0.0.1:$PORT/reminders/$REMINDER" -H 'content-type: application/json' -d '{"reason":"smoke complete"}'
check 202 -X POST "http://127.0.0.1:$PORT/compact-wake" -H 'content-type: application/json' -d "{\"agentId\":\"$PASEO_AGENT_ID\",\"resumeSteps\":\"read state and continue smoke\"}"
COMPACT_ID="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x).id)' "$OUT")"
# Compact observation may already have delivered and deleted it; cleanup is intentionally best effort.
curl -sS -X DELETE "http://127.0.0.1:$PORT/reminders/$COMPACT_ID" \
  -H 'content-type: application/json' -d '{"reason":"smoke cleanup"}' -o /dev/null || true
check 201 -X POST "http://127.0.0.1:$PORT/ledger" -H 'content-type: application/json' -d "{\"type\":\"known-red\",\"target\":\"$CHILD\",\"verdict\":\"smoke\",\"reason\":\"smoke only\"}"
check 200 "http://127.0.0.1:$PORT/ledger?target=$CHILD"
LEDGER="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x)[0].id)' "$OUT")"
check 200 -X POST "http://127.0.0.1:$PORT/ledger/$LEDGER/revoke" -H 'content-type: application/json' -d '{"reason":"smoke complete"}'
printf 'smoke complete; service log: %s\n' "$LOG"
