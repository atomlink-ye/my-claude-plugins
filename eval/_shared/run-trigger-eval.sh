#!/usr/bin/env bash
# Run a skill-creator-style trigger evaluation for one of this repo's skills.
#
# Runner selection
# ----------------
# By default this script uses the `claude` CLI exactly as `run_eval.py`
# would. Users on their own machines often prefer to point evaluation
# traffic at an alternative Anthropic-compatible endpoint (overflow
# quota, a different provider, a self-hosted gateway) so that running
# evals does not burn their main subscription. That preference is
# personal, not part of this marketplace — express it by exporting
# `EVAL_RUNNER` to a wrapper executable that takes the same argv as
# `claude` but injects the right env vars before exec'ing it.
#
# Example (set in your shell or a personal config skill, not here):
#
#   export EVAL_RUNNER=/path/to/your/runner-wrapper
#   eval/_shared/run-trigger-eval.sh opencode-companion
#
# If `EVAL_RUNNER` is unset, plain `claude` is used.
#
# Usage:
#   eval/_shared/run-trigger-eval.sh <skill-name> [extra run_eval.py args...]

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <skill-name> [extra run_eval.py args...]" >&2
  exit 2
fi

SKILL_NAME="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_DIR="${REPO_ROOT}/skills/${SKILL_NAME}"
EVAL_DIR="${REPO_ROOT}/eval/${SKILL_NAME}/evals"
SKILL_CREATOR_SCRIPTS="${SKILL_CREATOR_SCRIPTS:-${HOME}/.agents/skills/skill-creator/scripts}"
RUNNER_BIN="${EVAL_RUNNER:-claude}"

# Allow per-machine personal skills (lives outside the marketplace skills/ tree).
if [[ ! -d "${SKILL_DIR}" ]]; then
  if [[ -d "${HOME}/.agents/skills/${SKILL_NAME}" ]]; then
    SKILL_DIR="${HOME}/.agents/skills/${SKILL_NAME}"
  else
    echo "skill directory not found: ${SKILL_DIR}" >&2
    exit 1
  fi
fi

if [[ ! -f "${EVAL_DIR}/trigger-eval.json" ]]; then
  echo "trigger-eval.json not found at ${EVAL_DIR}/trigger-eval.json" >&2
  exit 1
fi

if [[ ! -f "${SKILL_CREATOR_SCRIPTS}/run_eval.py" ]]; then
  echo "skill-creator's run_eval.py not found at ${SKILL_CREATOR_SCRIPTS}/run_eval.py" >&2
  echo "set SKILL_CREATOR_SCRIPTS=<path-to-skill-creator/scripts> to override" >&2
  exit 1
fi

# Sanity-check the runner — accept either an absolute path or a name on PATH.
if [[ "${RUNNER_BIN}" == */* ]]; then
  if [[ ! -x "${RUNNER_BIN}" ]]; then
    echo "EVAL_RUNNER is set but not executable: ${RUNNER_BIN}" >&2
    exit 1
  fi
elif ! command -v "${RUNNER_BIN}" >/dev/null 2>&1; then
  echo "runner not on PATH: ${RUNNER_BIN} (set EVAL_RUNNER to override)" >&2
  exit 1
fi

# Keep --runner-mode claude-stream so run_eval.py's parser understands the
# wire format. Swap only the binary; the rest of the template is fixed.
RUNNER_COMMAND="${RUNNER_BIN} -p {query} --output-format stream-json --verbose --include-partial-messages{model_arg}"

cd "$(dirname "${SKILL_CREATOR_SCRIPTS}")"
exec python3 -m scripts.run_eval \
  --eval-set "${EVAL_DIR}/trigger-eval.json" \
  --skill-path "${SKILL_DIR}" \
  --runner-mode claude-stream \
  --runner-command "${RUNNER_COMMAND}" \
  --runner-shell bash \
  --verbose \
  "${@:2}"
