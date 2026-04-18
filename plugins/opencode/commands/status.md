---
description: Show OpenCode background job status for this repository
argument-hint: '[job-id] [--all] [--directory DIR]'
disable-model-invocation: true
allowed-tools: Bash(python3:*), Bash(node:*)
---

!`python3 - <<'PY'
import subprocess
args = '''$ARGUMENTS'''.strip()
base = ['node', '${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs', 'job']
cmd = base + (['status', args] if args else ['list'])
subprocess.run(cmd, check=True)
PY`

Present the companion output exactly as returned.
