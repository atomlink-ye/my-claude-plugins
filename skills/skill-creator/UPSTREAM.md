# Upstream

- Source: `/Users/fanye/.agents/skills/skill-creator`
- Vendored as: standalone optional marketplace plugin `skill-creator`
- Vendored on: 2026-05-12

## Local changes

- Added this `UPSTREAM.md` file to document provenance and packaging notes.
- Excluded upstream `tests/`, `__pycache__/`, `.pyc`, and generated output artifacts from the vendored skill.
- Preserved upstream production resources, including `LICENSE.txt`.
- Moved repo-owned automated tests to `eval/skill-creator/tests/` and wired them into root validation.
- Extracted shared runner utilities into `scripts/runner.py`.
- Extended runner support so eval and description-improvement flows can use configurable Claude/GLM, Codex, and OpenCode command runners.
- Added direct file-execution compatibility for primary Python entrypoints in the vendored skill.
- Updated `SKILL.md` examples to use the safer runner placeholder contract (`*_arg`, especially `{prompt_arg}`).
