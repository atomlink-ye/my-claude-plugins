#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-18787}"
export PORT
export PASEO_MANAGER_ID="${PASEO_MANAGER_ID:?Set PASEO_MANAGER_ID to the running manager agent id}"
export PASEO_PROVIDER="${PASEO_PROVIDER:-codex}"
export PASEO_MODEL="${PASEO_MODEL:-gpt-5.6-luna}"
export PASEO_CWD="${PASEO_CWD:-$PWD}"
LOG="${TMPDIR:-/tmp}/paseo-reminder.$$.log"
DATA="${TMPDIR:-/tmp}/paseo-reminder.$$.data"
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
PASEO_RUN_ARGS=(run -d --provider "$PASEO_PROVIDER")
[[ -n "$PASEO_MODEL" ]] && PASEO_RUN_ARGS+=(--model "$PASEO_MODEL")
PASEO_RUN_ARGS+=(--title companion-smoke --cwd "$PASEO_CWD" --json "Run this genuinely CPU-bound command and wait for it to finish before replying SMOKE_CHILD_DONE: python3 -c 'import hashlib,time; end=time.monotonic()+90; x=b\"seed\"; n=0; exec(\"while time.monotonic() < end:\\n x=hashlib.sha256(x).digest()\\n n+=1\"); print(n)' . Do not replace it with sleep.")
paseo "${PASEO_RUN_ARGS[@]}" >"$OUT"
CHILD="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); const j=JSON.parse(x); console.log(j.id||j.agentId)' "$OUT")"
for _ in $(seq 1 30); do
  paseo inspect "$CHILD" --json >"$OUT"
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(String(j.Status??j.status).toLowerCase()==="running"?0:1)' "$OUT" && break
  sleep 1
done
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(String(j.Status??j.status).toLowerCase()!=="running") process.exit(1)' "$OUT"
check 200 -X PUT "http://127.0.0.1:$PORT/children/$CHILD?agentId=$PASEO_MANAGER_ID"
check 200 "http://127.0.0.1:$PORT/children?agentId=$PASEO_MANAGER_ID"
check 200 "http://127.0.0.1:$PORT/children/$CHILD/briefing"

# Real delivery acceptance: on-idle must survive a busy recipient, while an
# interrupt is accepted immediately. Use ack mode so both records remain
# queryable after delivery.
check 201 -X POST "http://127.0.0.1:$PORT/messages" -H 'content-type: application/json' \
  -d "{\"to\":\"$CHILD\",\"from\":\"$PASEO_MANAGER_ID\",\"body\":\"SMOKE_ON_IDLE\",\"delivery\":\"on-idle\",\"mode\":\"ack\"}"
ON_IDLE_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(j.id)' "$OUT")"
check 200 "http://127.0.0.1:$PORT/messages?to=$CHILD&status=pending"
node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!rows.some(x=>x.id===process.argv[2])) process.exit(1)' "$OUT" "$ON_IDLE_ID"
# A cron tick during the busy window must not be mistaken for delivery. The
# repeating heartbeat remains one durable generation and retries after idle.
# Cross at least one minute boundary while the child is proven busy.
BUSY_CHECK_SECONDS=$((65 - 10#$(date +%S)))
sleep "$BUSY_CHECK_SECONDS"
check 200 "http://127.0.0.1:$PORT/messages?to=$CHILD&status=pending"
node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(rows.filter(x=>x.id===process.argv[2]).length!==1) process.exit(1)' "$OUT" "$ON_IDLE_ID"

check 201 -X POST "http://127.0.0.1:$PORT/messages" -H 'content-type: application/json' \
  -d "{\"to\":\"$CHILD\",\"from\":\"$PASEO_MANAGER_ID\",\"body\":\"SMOKE_INTERRUPT\",\"delivery\":\"interrupt\",\"mode\":\"ack\"}"
INTERRUPT_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(j.id)' "$OUT")"
for _ in $(seq 1 10); do
  curl -sS "http://127.0.0.1:$PORT/messages?to=$CHILD&status=delivered" >"$OUT"
  node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(rows.some(x=>x.id===process.argv[2])?0:1)' "$OUT" "$INTERRUPT_ID" && break
  sleep 1
done
node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!rows.some(x=>x.id===process.argv[2])) process.exit(1)' "$OUT" "$INTERRUPT_ID"

paseo wait "$CHILD" --timeout 120 --json >"$OUT"
for _ in $(seq 1 8); do
  curl -sS "http://127.0.0.1:$PORT/messages?to=$CHILD&status=delivered" >"$OUT"
  node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(rows.some(x=>x.id===process.argv[2])?0:1)' "$OUT" "$ON_IDLE_ID" && break
  sleep 15
done
node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(rows.filter(x=>x.id===process.argv[2]).length!==1) process.exit(1)' "$OUT" "$ON_IDLE_ID"
check 201 -X POST "http://127.0.0.1:$PORT/reminders" -H 'content-type: application/json' -d "{\"agentId\":\"$PASEO_MANAGER_ID\",\"delaySeconds\":300,\"message\":\"smoke reminder\"}"
REMINDER="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x).id)' "$OUT")"
check 200 -X DELETE "http://127.0.0.1:$PORT/reminders/$REMINDER" -H 'content-type: application/json' -d '{"reason":"smoke complete"}'
check 202 -X POST "http://127.0.0.1:$PORT/compact-wake" -H 'content-type: application/json' -d "{\"agentId\":\"$PASEO_MANAGER_ID\",\"resumeSteps\":\"read state and continue smoke\"}"
COMPACT_ID="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x).id)' "$OUT")"
# Compact observation may already have delivered and deleted it; cleanup is intentionally best effort.
curl -sS -X DELETE "http://127.0.0.1:$PORT/reminders/$COMPACT_ID" \
  -H 'content-type: application/json' -d '{"reason":"smoke cleanup"}' -o /dev/null || true
check 201 -X POST "http://127.0.0.1:$PORT/ledger" -H 'content-type: application/json' -d "{\"type\":\"known-red\",\"target\":\"$CHILD\",\"verdict\":\"smoke\",\"reason\":\"smoke only\"}"
check 200 "http://127.0.0.1:$PORT/ledger?target=$CHILD"
LEDGER="$(node -e 'const x=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(x)[0].id)' "$OUT")"
check 200 -X POST "http://127.0.0.1:$PORT/ledger/$LEDGER/revoke" -H 'content-type: application/json' -d '{"reason":"smoke complete"}'
printf 'smoke complete; service log: %s\n' "$LOG"
