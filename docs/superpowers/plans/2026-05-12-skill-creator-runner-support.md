# Skill Creator Runner Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor `skill-creator` into `my-claude-plugins` as a standalone optional plugin and complete its runner abstraction so evaluation and description-improvement flows support configurable Claude/GLM, Codex, and OpenCode command runners.

**Architecture:** Keep the vendored skill self-contained under `skills/skill-creator`, move repo-owned automated tests to `eval/skill-creator/tests`, and introduce shared runner utilities used by both trigger evaluation and description-improvement code paths. Preserve Claude-compatible defaults while routing shell execution through configurable runner templates and mode-specific output parsers.

**Tech Stack:** Python 3 scripts, Claude Code skill packaging, zsh shell execution, unittest/pytest-style Python tests, marketplace JSON metadata.

---

### Task 1: Vendor the skill into the repo as a standalone optional plugin

**Files:**
- Create: `skills/skill-creator/SKILL.md`
- Create: `skills/skill-creator/LICENSE.txt`
- Create: `skills/skill-creator/UPSTREAM.md`
- Create: `skills/skill-creator/agents/grader.md`
- Create: `skills/skill-creator/agents/comparator.md`
- Create: `skills/skill-creator/agents/analyzer.md`
- Create: `skills/skill-creator/assets/eval_review.html`
- Create: `skills/skill-creator/eval-viewer/generate_review.py`
- Create: `skills/skill-creator/eval-viewer/viewer.html`
- Create: `skills/skill-creator/references/schemas.md`
- Create: `skills/skill-creator/scripts/__init__.py`
- Create: `skills/skill-creator/scripts/utils.py`
- Create: `skills/skill-creator/scripts/run_eval.py`
- Create: `skills/skill-creator/scripts/run_loop.py`
- Create: `skills/skill-creator/scripts/improve_description.py`
- Create: `skills/skill-creator/scripts/aggregate_benchmark.py`
- Create: `skills/skill-creator/scripts/generate_report.py`
- Create: `skills/skill-creator/scripts/package_skill.py`
- Create: `skills/skill-creator/scripts/quick_validate.py`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

- [ ] **Step 1: Write the failing packaging test**

Create `/tmp/skill_creator_phase1_check.py` with assertions that fail until the plugin exists:

```python
from pathlib import Path
import json

repo = Path("/Users/fanye/.claude/plugins/marketplaces/my-claude-plugins")
skill = repo / "skills/skill-creator"
manifest = json.loads((repo / ".claude-plugin/marketplace.json").read_text())

assert skill.exists(), "vendored skill directory missing"
assert any(p["name"] == "skill-creator" for p in manifest["plugins"]), "optional plugin missing"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python /tmp/skill_creator_phase1_check.py`
Expected: FAIL because `skills/skill-creator/` and plugin entry do not exist yet.

- [ ] **Step 3: Copy production assets and add plugin wiring**

Use source files from `/Users/fanye/.agents/skills/skill-creator`, excluding `tests/`, `__pycache__/`, and `*.pyc`.

Add an `UPSTREAM.md` like:

```md
# Upstream Notes

- Source: local fork from `/Users/fanye/.agents/skills/skill-creator`
- Vendored: 2026-05-12
- Local modifications:
  - configurable eval runners
  - repo-specific test relocation under `eval/skill-creator`
  - future runner abstraction for description improvement
```

Append a standalone plugin entry in `.claude-plugin/marketplace.json`:

```json
{
  "name": "skill-creator",
  "description": "Vendored fork of skill-creator with configurable CLI runners for eval and optimization workflows.",
  "version": "0.3.0",
  "author": { "name": "atomlink-ye" },
  "source": "./",
  "strict": false,
  "skills": ["./skills/skill-creator"]
}
```

Update `README.md` to document the new optional plugin enablement:

```json
{
  "enabledPlugins": {
    "skill-creator@my-claude-plugins": true
  }
}
```

- [ ] **Step 4: Run the packaging test again**

Run: `python /tmp/skill_creator_phase1_check.py`
Expected: PASS.

- [ ] **Step 5: Validate no forbidden vendored artifacts remain**

Run: `python - <<'PY'
from pathlib import Path
root = Path('/Users/fanye/.claude/plugins/marketplaces/my-claude-plugins/skills/skill-creator')
bad = [str(p) for p in root.rglob('*') if '__pycache__' in p.parts or p.suffix == '.pyc' or 'tests' in p.parts]
assert not bad, bad
print('clean vendored tree')
PY`

Expected: `clean vendored tree`

---

### Task 2: Move and expand repo-owned tests under `eval/skill-creator`

**Files:**
- Create: `eval/skill-creator/tests/test_run_eval.py`
- Create: `eval/skill-creator/tests/test_improve_description.py`
- Create: `eval/skill-creator/tests/test_run_loop.py`
- Create: `eval/skill-creator/evals/README.md`

- [ ] **Step 1: Write the failing repo test for current import path**

Start `eval/skill-creator/tests/test_run_eval.py` with:

```python
import unittest
from skills.skill_creator.scripts import run_eval  # should fail until path setup is fixed

class Smoke(unittest.TestCase):
    def test_import(self):
        self.assertTrue(hasattr(run_eval, 'detect_trigger'))
```

Then adjust to the actual importable path once the repo layout is settled, e.g. via `sys.path` bootstrap inside tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest discover -s eval/skill-creator/tests`
Expected: FAIL on import or missing files.

- [ ] **Step 3: Recreate and extend tests in repo location**

At minimum, cover:

```python
class RenderRunnerCommandTests(unittest.TestCase):
    def test_renders_template_with_shell_quoted_placeholders(self): ...
    def test_model_arg_placeholder_is_empty_when_model_missing(self): ...
    def test_build_model_arg_for_text_mode(self): ...

class TriggerParsingTests(unittest.TestCase):
    def test_detects_claude_stream_trigger_from_partial_json(self): ...
    def test_detects_codex_json_trigger(self): ...
    def test_detects_opencode_json_trigger(self): ...
```

Add new tests for improvement-runner execution and loop pass-through in dedicated files.

- [ ] **Step 4: Run repo tests to verify they pass**

Run: `python -m unittest discover -s eval/skill-creator/tests`
Expected: PASS.

---

### Task 3: Extract shared runner utilities and harden `run_eval.py`

**Files:**
- Modify: `skills/skill-creator/scripts/run_eval.py`
- Modify: `skills/skill-creator/scripts/utils.py`
- Create: `skills/skill-creator/scripts/runner_utils.py`
- Test: `eval/skill-creator/tests/test_run_eval.py`

- [ ] **Step 1: Write a failing test for shared runner execution helpers**

Add assertions such as:

```python
def test_default_runner_command_supports_text_mode(self):
    self.assertEqual(
        runner_utils.default_runner_command('text'),
        'claude -p --output-format text{model_arg}'
    )
```

and

```python
def test_detect_trigger_rejects_unknown_mode(self):
    with self.assertRaises(ValueError):
        run_eval.detect_trigger('', 'unknown-mode', 'x')
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `python -m unittest eval.skill-creator.tests.test_run_eval`
Expected: FAIL because `runner_utils` and text-mode support do not exist yet.

- [ ] **Step 3: Implement shared runner helpers and refactor `run_eval.py`**

Create `runner_utils.py` with APIs like:

```python
def build_model_arg(runner_mode: str, model: str | None) -> str: ...
def default_runner_command(runner_mode: str) -> str: ...
def render_runner_command(...): ...
def run_shell_command(command: str, shell: str, cwd: str, env: dict, timeout: int, stdin: str | None = None) -> subprocess.CompletedProcess: ...
```

Refactor `run_eval.py` to import these helpers instead of embedding them.

- [ ] **Step 4: Run repo tests again**

Run: `python -m unittest discover -s eval/skill-creator/tests`
Expected: PASS.

- [ ] **Step 5: Smoke test the CLI help**

Run: `python -m skills.skill-creator.scripts.run_eval --help`

If module path syntax blocks execution, use direct file path instead:

Run: `python skills/skill-creator/scripts/run_eval.py --help`

Expected: usage output with `--runner-command`, `--runner-shell`, and `--runner-mode`.

---

### Task 4: Providerize `improve_description.py` and full loop execution

**Files:**
- Modify: `skills/skill-creator/scripts/improve_description.py`
- Modify: `skills/skill-creator/scripts/run_loop.py`
- Modify: `skills/skill-creator/SKILL.md`
- Test: `eval/skill-creator/tests/test_improve_description.py`
- Test: `eval/skill-creator/tests/test_run_loop.py`

- [ ] **Step 1: Write failing tests for configurable improvement runners**

Add tests like:

```python
def test_improve_description_uses_runner_command_for_text_mode(self):
    ...

def test_run_loop_passes_runner_config_to_improve_description(self):
    ...
```

Use `unittest.mock` to intercept subprocess execution and function calls.

- [ ] **Step 2: Run tests to verify failure**

Run: `python -m unittest eval.skill-creator.tests.test_improve_description eval.skill-creator.tests.test_run_loop`
Expected: FAIL because improvement path is still hardcoded to `claude -p`.

- [ ] **Step 3: Implement shared improvement-runner support**

Refactor `improve_description.py` toward APIs like:

```python
def call_text_runner(prompt: str, model: str | None, runner_mode: str, runner_command: str | None, runner_shell: str, project_root: str, skill_path: str) -> str:
    ...
```

Update `run_loop.py` so it passes improvement-runner configuration through to `improve_description()`.

Extend CLI options in `improve_description.py` for:

```python
parser.add_argument('--runner-command', default=None)
parser.add_argument('--runner-shell', default='zsh')
parser.add_argument('--runner-mode', choices=['claude-stream', 'codex-json', 'opencode-json', 'text'], default='text')
```

For text generation, prefer a plain-text execution mode rather than structured event parsing.

- [ ] **Step 4: Run repo tests again**

Run: `python -m unittest discover -s eval/skill-creator/tests`
Expected: PASS.

- [ ] **Step 5: Update examples in `SKILL.md`**

Add examples for both eval and improvement flows, including `glm claude` through `zsh` and best-effort Codex/OpenCode variants.

---

### Task 5: Real-runner verification and repo finish-up

**Files:**
- Modify: `README.md`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `skills/skill-creator/SKILL.md`
- Verify: `/tmp/skill-creator-*` temporary files only (not committed)

- [ ] **Step 1: Create temporary eval fixtures in `/tmp`**

Create `/tmp/skill-creator-evals.json` with a tiny trigger set:

```json
[
  {"query": "Help me create a new Claude Code skill and benchmark it", "should_trigger": true},
  {"query": "Write a Python fibonacci function", "should_trigger": false}
]
```

- [ ] **Step 2: Verify `glm claude` evaluation path**

Run:

```bash
python skills/skill-creator/scripts/run_eval.py \
  --eval-set /tmp/skill-creator-evals.json \
  --skill-path skills/skill-creator \
  --runner-shell zsh \
  --runner-mode claude-stream \
  --runner-command 'glm claude -p {query} --output-format stream-json --verbose --include-partial-messages{model_arg}'
```

Expected: JSON output with trigger statistics; command runs successfully via `glm` wrapper.

- [ ] **Step 3: Verify Codex and OpenCode evaluation paths**

Run:

```bash
python skills/skill-creator/scripts/run_eval.py \
  --eval-set /tmp/skill-creator-evals.json \
  --skill-path skills/skill-creator \
  --runner-shell zsh \
  --runner-mode codex-json \
  --runner-command 'codex exec --skip-git-repo-check --json --cd {project_root}{model_arg} "Use the skill at {skill_path} to answer: {query}"'
```

and:

```bash
python skills/skill-creator/scripts/run_eval.py \
  --eval-set /tmp/skill-creator-evals.json \
  --skill-path skills/skill-creator \
  --runner-shell zsh \
  --runner-mode opencode-json \
  --runner-command 'opencode run --format json --dir {project_root}{model_arg} "Use the skill at {skill_path} to answer: {query}"'
```

Expected: both commands execute; if trigger detection is best-effort, document actual observed limitations in README/SKILL docs rather than hiding them.

- [ ] **Step 4: Verify improvement runner path**

Run a small improvement smoke test using `/tmp` eval-results JSON and `glm claude` text mode.

Expected: `improve_description.py` returns JSON with a new description and history, without directly invoking hardcoded `claude -p`.

- [ ] **Step 5: Run final validation**

Run:

```bash
python -m unittest discover -s eval/skill-creator/tests
python skills/skill-creator/scripts/quick_validate.py skills/skill-creator
```

Expected: all tests pass and skill validation succeeds.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json README.md docs/superpowers/specs/2026-05-12-skill-creator-runner-support-design.md docs/superpowers/plans/2026-05-12-skill-creator-runner-support.md skills/skill-creator eval/skill-creator
git commit -m "feat(skill-creator): vendor runner-configurable skill workflow"
```

Only commit if the user explicitly requests a commit at that point.
