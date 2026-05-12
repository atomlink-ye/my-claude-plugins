## Skill Creator Runner Support Design

### Goal

Vendor the locally modified `skill-creator` into `my-claude-plugins` as a standalone optional plugin, then complete its runner abstraction so both trigger evaluation and description-improvement workflows can operate through configurable CLI runners instead of being coupled to `claude -p`.

### Scope

This design covers two phases delivered in one implementation stream:

1. **Phase 2 landing** — import `skill-creator` into the repo as a vendored fork with marketplace wiring, repo-aligned tests, and documentation.
2. **Phase 3 completion** — extend the runner abstraction beyond `run_eval.py` so the full skill-optimization flow can evaluate and improve using Claude/GLM, Codex, and OpenCode-compatible command runners where the host behavior supports it.

Out of scope:

- Changing unrelated marketplace skills.
- Rewriting the skill from scratch.
- Building a generic cross-agent framework beyond what `skill-creator` needs.

### Packaging Decision

The skill will be added as a **standalone optional plugin**, not merged into `my-skills`.

Reasons:

- avoids surprise activation for users who only want the current bundle
- reduces collision risk with upstream `skill-creator`
- makes fork ownership explicit
- allows iteration without changing the default skill bundle contract

### Repository Layout

Add these artifacts to `my-claude-plugins`:

- `skills/skill-creator/` — vendored production skill assets only
- `eval/skill-creator/tests/` — repo-owned automated tests
- `eval/skill-creator/evals/` — minimal reproducible eval fixtures if needed
- `docs/superpowers/specs/...` — this design doc

Do not include local `tests/` under shipped skill source. Move or recreate them under `eval/skill-creator/tests/` to follow repo policy.

Do not vendor `__pycache__`, `.pyc`, generated logs, run outputs, or transient test artifacts.

### Vendored Fork Policy

The vendored skill must preserve upstream licensing and make local ownership clear.

Required files:

- upstream `LICENSE.txt`
- `UPSTREAM.md` or equivalent note documenting:
  - origin path/source
  - vendored date
  - local modifications
  - known divergence from upstream

The fork should remain named `skill-creator` at the skill level for behavior continuity, but the marketplace plugin name should be distinct enough to avoid confusion.

### Architecture

#### 1. Runner abstraction

Introduce one consistent runner contract used by both evaluation and description improvement.

Core concepts:

- `runner_mode` — how output is parsed and how trigger/evidence detection works
- `runner_command` — shell template used to execute the runner
- `runner_shell` — shell entrypoint, default `zsh` so local wrappers like `glm` work
- placeholder rendering — stable substitution for prompt, skill path, project root, model, temp command files, and evidence markers

The abstraction must support at least these modes:

- `claude-stream`
- `codex-json`
- `opencode-json`
- `text` or equivalent plain-text mode for improvement calls where structured tool events are not needed

#### 2. Trigger evaluation lane

`run_eval.py` remains responsible for skill-trigger benchmarking, but it should no longer contain the only runner logic. Common runner execution and parsing utilities should live in shared helper code so the improvement path can reuse them.

Claude-specific behavior can still create `.claude/commands/...` entries when needed, because that is part of how Claude exposes dynamic skills. Non-Claude runners should rely on prompt-level or path-level injection rather than assuming Claude’s command discovery model.

#### 3. Improvement lane

`improve_description.py` currently hardcodes `claude -p`. It should move to the shared runner contract.

Expected behavior:

- default path remains Claude-compatible for best current quality
- `glm claude` must work through `zsh -lc`
- Codex/OpenCode should be supported through configurable commands if they can reliably return plain text output for the improvement prompt
- model flags must be runner-aware rather than globally assuming `--model`

This does **not** require identical prompting semantics across runners. The shared contract is execution-level, not behavior-level.

#### 4. Loop orchestration

`run_loop.py` should pass through the runner contract for both evaluation and improvement, without embedding provider-specific decisions.

The loop remains responsible for:

- train/test splitting
- iteration history
- live reporting
- choosing best description by held-out score

The loop should not need to know how a runner command is actually executed.

### Data Flow

1. User provides eval set and skill path.
2. Runner config is resolved from CLI args.
3. `run_eval.py` executes query runs using runner utilities.
4. Trigger/evidence parser maps raw output into boolean trigger results.
5. `run_loop.py` aggregates train/test outcomes.
6. `improve_description.py` calls the configured text-generation runner to propose a new description.
7. Loop repeats until termination condition.

### Error Handling

The system should fail explicitly for:

- unsupported runner mode
- missing required placeholders for a selected mode
- nonzero subprocess exit during improvement calls
- malformed or absent structured output when a structured mode is required

For evaluation runs, individual query failures should continue to be recorded as failed attempts instead of aborting the whole batch unless the failure indicates a global configuration error.

Add clear stderr messages for misconfigured runner commands so users can see whether the issue is command syntax, shell resolution, missing binary, or output-shape mismatch.

### Testing Strategy

Development follows TDD.

#### Permanent repo tests

Create automated tests under `eval/skill-creator/tests/` for:

- command template rendering
- model flag rendering by mode
- structured trigger detection for Claude/Codex/OpenCode
- text-runner execution behavior for improvement mode
- loop argument pass-through into eval and improvement layers

Prefer deterministic unit tests with mocked subprocess results for parser and orchestration logic.

#### Temporary development tests

Use `/tmp` for transient fixtures and local integration scripts during development, including:

- temporary eval sets
- scratch skill directories
- CLI smoke scripts
- captured runner outputs

These must not be committed.

#### Real runner verification

Before considering the work complete, run host-level smoke tests for:

- `glm claude ...` via `zsh` wrapper from `~/.zshrc`
- `codex exec ...`
- `opencode run ...`

For Claude-path validation on this machine, use `glm claude`, not direct `claude`, to match the required environment.

### Documentation Changes

Update:

- skill docs to explain standalone plugin installation and fork status
- `SKILL.md` examples for eval and improvement runner configuration
- marketplace README and manifest for the new optional plugin

The docs must clearly distinguish:

- trigger evaluation runner support
- description-improvement runner support
- best-effort versus fully verified modes

### Acceptance Criteria

The implementation is acceptable when all of the following are true:

1. `skill-creator` exists in `my-claude-plugins` as a standalone optional plugin.
2. Vendored skill source is clean and repo-policy compliant.
3. Repo-owned automated tests live under `eval/skill-creator/`.
4. `run_eval.py` supports configurable runners with verified Claude/Codex/OpenCode parsing.
5. `run_loop.py` passes runner configuration through the full loop.
6. `improve_description.py` no longer hardcodes `claude -p` and can use the shared runner contract.
7. `glm claude` works as the Claude-path smoke-tested runner on this machine.
8. Documentation explains installation, fork ownership, and runner configuration.

### Implementation Notes

This work should be led as an orchestration task:

- lead agent owns decomposition, acceptance, and final verification
- implementation and test-writing can be delegated in bounded lanes
- review should be independent from implementation when the code changes settle

### Spec Self-Review

- No placeholders remain.
- Scope includes both the repo landing and full provider-support completion requested after approval.
- Testing requirements explicitly separate `/tmp` transient work from committed repo tests.
- The design keeps default Claude compatibility while allowing configurable runners for Codex and OpenCode.
