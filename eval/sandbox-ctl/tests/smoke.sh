#!/usr/bin/env bash
set -euo pipefail

# SANDBOX_CTL_REAL_SMOKE=1 enables the opt-in network smoke in real-smoke.sh.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="${ROOT}/skills/sandbox-ctl/scripts/sandbox-ctl.mjs"
LEGACY="${ROOT}/skills/daytona-companion/scripts/daytona-manager.mjs"
FIXTURE="${ROOT}/eval/sandbox-ctl/tests/fixtures/exit7-adapter.mjs"
CONTROL_FIXTURE="${ROOT}/eval/sandbox-ctl/tests/fixtures/control125-adapter.mjs"
TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/sandbox-ctl-offline.XXXXXX")"
trap 'rm -f "$TMP_OUT"' EXIT

help_out="$(node "$CLI" --help)"
grep -q 'Usage: sandbox-ctl' <<<"$help_out"
[[ -x "${ROOT}/skills/sandbox-ctl/scripts/sandbox-ctl.mjs" ]]
grep -q 'name: sandbox-ctl' "${ROOT}/skills/sandbox-ctl/SKILL.md"

json_help="$(node "$CLI" --json --help)"
[[ "$(wc -l <<<"$json_help" | tr -d ' ')" -eq 1 ]]
node -e 'const x=JSON.parse(process.argv[1]); if(x.ok!==true||x.command!=="help") process.exit(1)' "$json_help"

set +e
bad_out="$(node "$CLI" --json --adapter unsupported list 2>/dev/null)"
bad_status=$?
set -e
[[ "$bad_status" -eq 1 ]]
node -e 'const x=JSON.parse(process.argv[1]); if(x.ok!==false||!x.error) process.exit(1)' "$bad_out"

set +e
SANDBOX_CTL_ADAPTER_MODULE="$FIXTURE" node "$CLI" --json exec -- false >"$TMP_OUT"
exit7_status=$?
set -e
[[ "$exit7_status" -eq 7 ]]
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); if(x.exitCode!==7) process.exit(1)' "$TMP_OUT"
grep -q 'Usage: sandbox-ctl' <(node "$LEGACY" --help)

set +e
SANDBOX_CTL_ADAPTER_MODULE="$CONTROL_FIXTURE" node "$CLI" --json exec -- false >"$TMP_OUT"
control_status=$?
set -e
[[ "$control_status" -eq 125 ]]
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); if(x.exitCode!==125||x.ok!==false) process.exit(1)' "$TMP_OUT"

CONFIG_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-ctl-config.XXXXXX")"
trap 'rm -f "$TMP_OUT"; rm -rf "$CONFIG_ROOT"' EXIT
node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { writeConfig } = await import(pathToFileURL(process.argv[1]).href); writeConfig(process.argv[2], {schemaVersion:1, adapter:"daytona", active:null, sandboxes:{dev:{sandboxId:"offline-s1", remoteWorkspace:"/workspace/dev"}}});' "${ROOT}/skills/sandbox-ctl/scripts/project-config.mjs" "$CONFIG_ROOT"
use_out="$(node "$CLI" --json use dev --directory "$CONFIG_ROOT")"
node -e 'const x=JSON.parse(process.argv[1]); if(x.name!=="dev"||x.sandboxId!=="offline-s1") process.exit(1)' "$use_out"
echo 'PASS: sandbox-ctl offline smoke'
