#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
skill_dir="$repo_dir/skills/figma-console"

for required in SKILL.md references/data-paths.md references/editing-and-prototyping.md references/export-format.md references/mcporter.md scripts/export.py scripts/serialize-selection.js; do
  test -f "$skill_dir/$required"
done
grep -q '^name: figma-console$' "$skill_dir/SKILL.md"
grep -q '^user-invocable: true$' "$skill_dir/SKILL.md"
grep -q 'mcporter list figma-console-mcp --schema --config ~/.mcporter/mcporter.json' "$skill_dir/SKILL.md"
grep -q '"code"' "$skill_dir/SKILL.md"
grep -q 'figma.currentPage.selection' "$skill_dir/scripts/serialize-selection.js"
grep -q 'absoluteBoundingBox' "$skill_dir/scripts/serialize-selection.js"
grep -q 'reactions' "$skill_dir/scripts/serialize-selection.js"
grep -q 'strokeWeight' "$skill_dir/scripts/serialize-selection.js"
grep -q '^return (() =>' "$skill_dir/scripts/serialize-selection.js"
if grep -Eiq 'token|secret|password' "$skill_dir/scripts/serialize-selection.js"; then
  echo "FAIL: serializer contains secret material" >&2
  exit 1
fi
if grep -q 'figma_execute.*script' "$skill_dir/SKILL.md"; then
  echo "FAIL: stale figma_execute script argument" >&2
  exit 1
fi
if grep -R -q -- '--args -' "$skill_dir" "$repo_dir/docs/figma-console.md"; then
  echo "FAIL: incompatible stdin --args form" >&2
  exit 1
fi
grep -q -- '--config ~/.mcporter/mcporter.json' "$repo_dir/docs/figma-console.md"

python3 - <<'PY' "$repo_dir/.claude-plugin/marketplace.json" "$repo_dir/eval/figma-console/evals/evals.json" "$repo_dir/eval/figma-console/evals/trigger-eval.json"
import json, sys
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as fh:
        json.load(fh)
print("PASS: JSON parses")
PY

fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
cat >"$fixture_dir/frame.json" <<'JSON'
{
  "id": "10:root", "name": "Root & Frame", "type": "FRAME",
  "absoluteBoundingBox": {"x": 100, "y": 200, "width": 240, "height": 160},
  "fills": [{"type": "SOLID", "color": {"r": 1, "g": 1, "b": 1}}],
  "cornerRadius": 12, "clipsContent": true,
  "effects": [{"type": "DROP_SHADOW", "offset": {"x": 2, "y": 3}, "radius": 4, "color": {"r": 0, "g": 0, "b": 0, "a": 0.3}}],
  "children": [{
    "id": "10:parent", "name": "Hidden parent", "type": "FRAME", "box": {"x": 10, "y": 20, "width": 100, "height": 80},
    "visible": false, "opacity": 0.5, "clipsContent": true,
    "children": [{
      "id": "10:text", "name": "Text <safe>", "type": "TEXT", "box": {"x": 10, "y": 20, "width": 100, "height": 30},
      "characters": "Hello <world> & goodbye",
      "style": {"fontFamily": "Bad\";background:url(https://evil)", "fontSize": 16, "fontWeight": 600, "lineHeightPx": 20, "letterSpacing": {"unit": "PERCENT", "value": 2.5}, "textAlignHorizontal": "CENTER"},
      "fills": [{"type": "SOLID", "opacity": 0.5, "color": {"r": 0.1, "g": 0.2, "b": 0.3, "a": 0.8}}], "visible": true,
      "children": [{"id": "10:leaf", "name": "leaf", "type": "RECTANGLE", "box": {"x": 2, "y": 3, "width": 5, "height": 6}, "fills": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0}}]}]
    }]
  }]
}
JSON
python3 "$skill_dir/scripts/export.py" "$fixture_dir/frame.json" --out-dir "$fixture_dir/out" >/dev/null
html_out="$fixture_dir/out/frame.html"
css_out="$fixture_dir/out/frame.css"
grep -q 'Hello &lt;world&gt; &amp; goodbye' "$html_out"
grep -q 'figma-e-0002.*figma-e-0003' "$html_out"
grep -q 'figma-e-0003.*figma-e-0004' "$html_out"
grep -q 'border-radius:12px' "$css_out"
grep -q 'box-shadow:2px 3px 4px 0px rgba(0, 0, 0, 0.300)' "$css_out"
grep -q 'color:rgba(26, 51, 76, 0.400)' "$css_out"
grep -q 'letter-spacing:2.5%' "$css_out"
if grep 'figma-e-0003 {' "$css_out" | grep -q 'background-color'; then
  echo "FAIL: text fill mapped to background" >&2
  exit 1
fi
grep -q '#figma-e-0002 .*display:none' "$css_out"
grep -q '#figma-e-0002 .*opacity:0.5' "$css_out"
grep -q '#figma-e-0002 .*overflow:hidden' "$css_out"
grep -q '#figma-e-0004 .*left:2px.*top:3px' "$css_out"
grep -q 'box-sizing:border-box' "$css_out"
if grep -Eq '(^|[^\\])";background:url' "$css_out" || grep -q 'Bad";background' "$css_out"; then
  echo "FAIL: CSS font string injection" >&2
  exit 1
fi

cat >"$fixture_dir/nodes.json" <<'JSON'
{"result":{"nodes":{"a":{"document":{"id":"a","name":"A","type":"FRAME","absoluteBoundingBox":{"x":100,"y":50,"width":20,"height":10},"children":[{"id":"nested","name":"Nested","type":"RECTANGLE","box":{"x":25,"y":0,"width":30,"height":5}}]}},"b":{"document":{"id":"b","name":"B","type":"RECTANGLE","absoluteBoundingBox":{"x":140,"y":80,"width":10,"height":10}}}}}}
JSON
python3 "$skill_dir/scripts/export.py" "$fixture_dir/nodes.json" --out-dir "$fixture_dir/nodes-out" >/dev/null
grep -q '#figma-e-0004 .*left:40px.*top:30px' "$fixture_dir/nodes-out/frame.css"
grep -q '.figma-root .*width:55px' "$fixture_dir/nodes-out/frame.css"
if grep -q 'left:100px\|top:80px' "$fixture_dir/nodes-out/frame.css"; then
  echo "FAIL: synthetic root origin not normalized" >&2
  exit 1
fi
printf '%s\n' '{"resultAnalysis":{"warning":"stale read"},"result":{"nodes":[]}}' >"$fixture_dir/warning.json"
set +e
python3 "$skill_dir/scripts/export.py" "$fixture_dir/warning.json" --out-dir "$fixture_dir/warning-out" >/dev/null 2>&1
warning_rc=$?
set -e
test "$warning_rc" -eq 2
test ! -e "$fixture_dir/warning-out"

printf '%s\n' '{"_mcp":"figma-console-mcp","success":false,"error":"bridge failed"}' >"$fixture_dir/failure.json"
set +e
python3 "$skill_dir/scripts/export.py" "$fixture_dir/failure.json" --out-dir "$fixture_dir/failure-out" >/dev/null 2>&1
failure_rc=$?
set -e
test "$failure_rc" -eq 2
test ! -e "$fixture_dir/failure-out"

printf '%s\n' '{"_mcp":"figma-console-mcp","success":true,"result":null,"resultAnalysis":{"warning":null}}' >"$fixture_dir/null-result.json"
set +e
python3 "$skill_dir/scripts/export.py" "$fixture_dir/null-result.json" --out-dir "$fixture_dir/null-out" >/dev/null 2>&1
null_rc=$?
set -e
test "$null_rc" -eq 2
test ! -e "$fixture_dir/null-out"

cat >"$fixture_dir/negative.json" <<'JSON'
{"nodes":{"a":{"document":{"id":"a","name":"A","type":"FRAME","absoluteBoundingBox":{"x":100,"y":100,"width":20,"height":20},"children":[{"id":"left","name":"Left","type":"RECTANGLE","absoluteBoundingBox":{"x":80,"y":70,"width":10,"height":10}}]}}}}
JSON
python3 "$skill_dir/scripts/export.py" "$fixture_dir/negative.json" --out-dir "$fixture_dir/negative-out" >/dev/null
grep -q '.figma-root .*width:40px.*height:50px' "$fixture_dir/negative-out/frame.css"
grep -q '#figma-e-0002 .*left:20px.*top:30px' "$fixture_dir/negative-out/frame.css"
grep -q '#figma-e-0003 .*left:-20px.*top:-30px' "$fixture_dir/negative-out/frame.css"

cp "$html_out" "$fixture_dir/first.html"
cp "$css_out" "$fixture_dir/first.css"
python3 "$skill_dir/scripts/export.py" "$fixture_dir/frame.json" --out-dir "$fixture_dir/out" >/dev/null
cmp "$fixture_dir/first.html" "$html_out"
cmp "$fixture_dir/first.css" "$css_out"

set +e
python3 "$skill_dir/scripts/export.py" "$fixture_dir/frame.json" --out-dir "$fixture_dir/path-out" --html ../evil.html >/dev/null 2>&1
path_rc=$?
set -e
test "$path_rc" -eq 2
test ! -e "$fixture_dir/evil.html"
test ! -e "$fixture_dir/path-out"
echo "PASS: figma-console smoke"
