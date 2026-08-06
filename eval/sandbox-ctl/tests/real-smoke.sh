#!/usr/bin/env bash
set -euo pipefail

if [[ "${SANDBOX_CTL_REAL_SMOKE:-0}" != "1" ]]; then
  echo 'SKIP: set SANDBOX_CTL_REAL_SMOKE=1 to run the Daytona canary'
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="${ROOT}/skills/sandbox-ctl/scripts/sandbox-ctl.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-ctl-real-work.XXXXXX")"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-ctl-real-out.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
OUT="$(cd "$OUT" && pwd -P)"
SNAPSHOT="${SANDBOX_CTL_SNAPSHOT:-agent-exec-standard-medium}"
TRANSFER_BINDING="transfer"
GIT_BINDING="git"
# Bash 3.2 treats an empty array expansion as unbound under `set -u`.
CREATED_BINDINGS=("__none__")

json_field() {
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v=x[process.argv[2]]; if(v===undefined||v===null||v==="") process.exit(1); process.stdout.write(String(v))' "$1" "$2"
}

cleanup() {
  local status=$?
  set +e
  local failed=0
  for binding in "${CREATED_BINDINGS[@]}"; do
    [[ "$binding" == "__none__" ]] && continue
    node "$CLI" --json down --directory "$WORK" --sandbox "$binding" >"$OUT/cleanup-${binding}.json" 2>"$OUT/cleanup-${binding}.err" || failed=1
  done
  if [[ "$failed" -eq 0 && "$status" -eq 0 ]]; then
    rm -rf "$WORK" "$OUT"
  else
    echo "WARNING: canary or exact-binding cleanup failed; retained evidence at $WORK and $OUT" >&2
  fi
  if [[ "$status" -ne 0 ]]; then return "$status"; fi
  return "$failed"
}
trap cleanup EXIT

git -C "$WORK" init -q
git -C "$WORK" config user.name sandbox-ctl
git -C "$WORK" config user.email sandbox-ctl@example.invalid
printf 'tracked fixture\n' >"$WORK/tracked.txt"
printf 'CANARY_ONLY=not-a-real-secret\n' >"$WORK/.env"
git -C "$WORK" add tracked.txt
git -C "$WORK" commit -qm initial

CREATED_BINDINGS+=("$TRANSFER_BINDING")
node "$CLI" --json up --directory "$WORK" --name "$TRANSFER_BINDING" --snapshot "$SNAPSHOT" --auto-stop 30 --auto-archive 10080 --auto-delete 60 >"$OUT/up-transfer.json"
TRANSFER_ID="$(json_field "$OUT/up-transfer.json" sandboxId)"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const b=c.sandboxes.transfer; if(c.active!=="transfer"||!b||b.sandboxId!==process.argv[2]) process.exit(1)' "$WORK/.sandbox-ctl/config.json" "$TRANSFER_ID"

# Safe bundle excludes .env; explicit full mode includes it.
node "$CLI" --json push --directory "$WORK" --sandbox "$TRANSFER_BINDING" --mode bundle >"$OUT/push-bundle.json"
node "$CLI" --json exec --directory "$WORK" --sandbox "$TRANSFER_BINDING" -- sh -lc 'test -f tracked.txt && test ! -e .env' >"$OUT/check-bundle.json"
node "$CLI" --json push --directory "$WORK" --sandbox "$TRANSFER_BINDING" --mode full --include-sensitive >"$OUT/push-full.json"
node "$CLI" --json exec --directory "$WORK" --sandbox "$TRANSFER_BINDING" -- sh -lc 'grep -qx "CANARY_ONLY=not-a-real-secret" .env' >"$OUT/check-full.json"
mkdir "$WORK/full-pull"
node "$CLI" --json pull --directory "$WORK" --sandbox "$TRANSFER_BINDING" --mode full --include-sensitive --output "$WORK/full-pull" >"$OUT/pull-full.json"
grep -qx 'CANARY_ONLY=not-a-real-secret' "$WORK/full-pull/.env"

# Human exec must expose the first chunk while the command is still running,
# then preserve the remote exit code.
set +e
node "$CLI" exec --directory "$WORK" --sandbox "$TRANSFER_BINDING" -- sh -lc 'printf START; sleep 2; printf END; exit 7' >"$OUT/stream.out" 2>"$OUT/stream.err" &
STREAM_PID=$!
sleep 0.8
grep -q START "$OUT/stream.out"
kill -0 "$STREAM_PID"
wait "$STREAM_PID"
STREAM_STATUS=$?
set -e
[[ "$STREAM_STATUS" -eq 7 ]]
grep -q END "$OUT/stream.out"

mkdir "$WORK/artifacts"
set +e
node "$CLI" --json exec --directory "$WORK" --sandbox "$TRANSFER_BINDING" --artifacts "$WORK/artifacts" -- sh -lc 'printf artifact-out; printf artifact-err >&2; exit 7' >"$OUT/artifact-exec.json"
ARTIFACT_STATUS=$?
set -e
[[ "$ARTIFACT_STATUS" -eq 7 ]]
grep -q artifact-out "$WORK/artifacts/stdout.txt"
grep -q artifact-err "$WORK/artifacts/stderr.txt"
grep -qx 7 "$WORK/artifacts/exit-code.txt"

# A second named binding proves multi-sandbox config and keeps Git's remote
# workspace empty, so the non-destructive Git bootstrap path is exercised.
CREATED_BINDINGS+=("$GIT_BINDING")
node "$CLI" --json up --directory "$WORK" --name "$GIT_BINDING" --no-use --snapshot "$SNAPSHOT" >"$OUT/up-git.json"
GIT_ID="$(json_field "$OUT/up-git.json" sandboxId)"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(c.active!=="transfer"||c.sandboxes.git.sandboxId!==process.argv[2]) process.exit(1)' "$WORK/.sandbox-ctl/config.json" "$GIT_ID"
node "$CLI" --json push --directory "$WORK" --sandbox "$GIT_BINDING" --mode git >"$OUT/push-git.json"
node "$CLI" --json exec --directory "$WORK" --sandbox "$GIT_BINDING" -- sh -lc 'git config user.name sandbox-ctl; git config user.email sandbox-ctl@example.invalid; printf "remote commit\n" > remote-change.txt; git add remote-change.txt; git commit -m remote-change' >"$OUT/remote-commit.json"
node "$CLI" --json pull --directory "$WORK" --sandbox "$GIT_BINDING" --mode git >"$OUT/pull-git.json"
git -C "$WORK" show sandbox-ctl/git:remote-change.txt | grep -qx 'remote commit'

node "$CLI" --json down --directory "$WORK" --sandbox "$GIT_BINDING" >"$OUT/down-git.json"
CREATED_BINDINGS=("__none__" "$TRANSFER_BINDING")
node "$CLI" --json down --directory "$WORK" --sandbox "$TRANSFER_BINDING" >"$OUT/down-transfer.json"
CREATED_BINDINGS=("__none__")

node "$CLI" --json list >"$OUT/final-inventory.json"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const ids=new Set((x.sandboxes||[]).map(v=>v.id)); if(ids.has(process.argv[2])||ids.has(process.argv[3])) process.exit(1)' "$OUT/final-inventory.json" "$TRANSFER_ID" "$GIT_ID"
echo "PASS: sandbox-ctl Daytona canary (${TRANSFER_ID}, ${GIT_ID})"
