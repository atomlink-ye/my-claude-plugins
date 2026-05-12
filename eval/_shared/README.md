# Shared Eval Helpers

This directory provides the runner glue and conventions used by every per-skill `eval/<skill>/evals/` set in this repo.

## Layout

```
eval/_shared/
├── run-trigger-eval.sh         # convenience entry: run a skill's trigger-eval
└── README.md                   # this file

eval/<skill>/
├── evals/
│   ├── trigger-eval.json       # skill-creator schema: should_trigger / should_not_trigger queries
│   ├── evals.json              # optional: outcome eval (prompt + expected_output + expectations)
│   └── routing-eval.json       # optional: only for skills that emit a route decision
└── tests/                      # optional: smoke/unit/integration tests for the skill's scripts
    ├── smoke.sh                # quickest sanity check (script `--help`, `serve status`, etc.)
    ├── unit/*.test.mjs         # vitest unit tests for skill-side helpers
    └── integration/*.test.mjs  # vitest integration tests
```

## Conventions

- All test/eval artifacts live under `eval/<skill>/`. Never put tests or fixtures back into `skills/<skill>/` — the marketplace ships those directories as production artifacts.
- Trigger evals follow the skill-creator schema (`should_trigger` / `should_not_trigger` lists of query strings).
- Outcome evals follow the skill-creator `evals.json` schema (`{id, prompt, expected_output, expectations[]}`).
- Routing evals are a thin extension for skills that emit a route enum (see e.g. a personal routing profile's scene-preset enum). The marketplace itself does not define a route enum — that belongs to per-user routing profiles.
- Smoke tests must be safe to run unattended (no network writes, no real sandboxes, no credentials prompts).

## Choosing a runner

`run-trigger-eval.sh` calls the `claude` CLI through skill-creator's `run_eval.py`. If you want eval runs to go through a different Anthropic-compatible endpoint or a wrapped CLI (e.g. to spend overflow quota instead of your primary subscription), set the `EVAL_RUNNER` env var to your wrapper executable:

```bash
export EVAL_RUNNER=/absolute/path/to/your-claude-wrapper
eval/_shared/run-trigger-eval.sh opencode-companion
```

Such a wrapper is a personal configuration choice and lives in your dotfiles or a personal config skill, not in this marketplace. The wrapper must accept the same argv as `claude` and produce the same `--output-format stream-json` wire format.

If `EVAL_RUNNER` is unset, plain `claude` is used.

## Running A Trigger Eval

```bash
eval/_shared/run-trigger-eval.sh <skill-name>
```

Extra args are forwarded to `run_eval.py`:

```bash
eval/_shared/run-trigger-eval.sh opencode-companion --runs-per-query 1 --timeout 20
```

If `~/.agents/skills/skill-creator/scripts/run_eval.py` is missing or installed at a custom path, set:

```bash
SKILL_CREATOR_SCRIPTS=/custom/path/to/skill-creator/scripts eval/_shared/run-trigger-eval.sh <skill-name>
```

## Eval Coverage Plan

Not all skills get the full eval kit on day one. The deliberate phasing is:

| Skill | trigger-eval | outcome eval | smoke tests |
|---|---|---|---|
| `opencode-companion` | ✓ | ✓ | ✓ (`eval/opencode/tests/`) |
| `mcp-skill` | ✓ | ✓ | — |
| `agentic-orchestration` | ✓ skeleton | — | — |
| `paseo-companion` | ✓ skeleton | — | ✓ smoke (`--help`) |
| `daytona-companion` | ✓ skeleton | — | ✓ unit + smoke |
| `google-workspace` | — (external CLI wrapper) | — | — |

When a skeleton skill's description changes meaningfully, promote it from skeleton to populated trigger eval before merging.
