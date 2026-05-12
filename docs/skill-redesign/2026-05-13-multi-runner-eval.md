# 2026-05-13 personalized-agent-config multi-runner eval

## 1. Capability column rationale

I added a parallel **Capability** column beside the existing cost multipliers, anchored at **`openai/gpt-5.4 high` = 1.0**.

- The values are **order-of-magnitude routing hints, not benchmark scores**.
- The goal is to make the asymmetry obvious: capability moves a little; cost moves a lot.
- I kept values to coarse 1–2 significant digits (`~1.05`, `~0.95`, `~0.9`, etc.).

### `SKILL.md` Engine Tiers values

- **Flagship** → `~1.01`
- **Strong** → `~1.03`
- **Workhorse** → `1.0 baseline`
- **Cheap** → `~0.94`
- **Effectively-free** → `~0.93`

### `references/model-cost-map.md` per-model values

- **Claude Opus (current)** → `~1.01`
- **Claude Sonnet (current)** → `~1.0`
- **openai/gpt-5.5 high** → `~1.05`
- **openai/gpt-5.5 medium** → `~1.03`
- **openai/gpt-5.4 high** → `1.0 baseline`
- **openai/gpt-5.4-mini** → `~0.95`
- **openai/gpt-5.3-codex-spark** → `~0.92`
- **google/gemini-3.1-pro-preview** → `~0.98`
- **google/gemini-3-flash-preview** → `~0.94`
- **google/gemini-flash-lite** → `~0.9`
- **zai-coding-plan/glm-5.1** → `~0.95`
- **zai-coding-plan/glm-4.7** → `~0.9`
- **GitHub Copilot claude-opus-4.6** → `~1.01`
- **GitHub Copilot gemini-3.1-pro-preview** → `~0.98`
- **GitHub Copilot grok-code-fast-1** → `~0.9`

### One-line implication added under each table

> Capability spread is ~5–10%, cost spread is ~50–100× — cost-per-capability-unit is dominated by cost.

## 2. Opus orchestration note

This nuance was **not explicitly present** before.

Added:

- In `references/model-cost-map.md`, Claude Opus now notes that its standout edge is **orchestration-heavy meta-work**: planning a sequence of moves, judging intermediate outputs, and holding a long coordination thread together.
- In `SKILL.md`, the Flagship row now explicitly includes **orchestration-heavy coordination** in the sweet spot.

## 3. 3-runner trigger-eval results

No runner-level auth/runtime error surfaced during these eval runs.

### Runner 1 — `claude-stream` via `glm-claude`

- **Pass rate:** `8/20 (40%)`
- **Recall failures (12):**
  - `我现在打算起一个 review lane，按我个人路由偏好应该 fresh 起一个 OpenCode 还是 reuse implementer`
  - `你能不能给我一个明确的 route enum，决定下面这种长任务应该走 lead_direct / remote_sandbox / opencode_orchestrator 哪个`
  - `Gemini Flash 在我这个项目下能用来干啥，能写文件吗，写之前要不要 verification`
  - `这个 feature 我应该在本地跑 pnpm test 还是丢 daytona sandbox 上跑，本地内存只有 16G`
  - `这种长链推理 + 高度模糊的 feature，是不是应该走 Claude Max 让我自己人工拉起`
  - `我准备把这个 implementation 任务派出去，应该用 OpenCode 还是 Paseo，按我的偏好哪个更省 quota`
  - `我让 OpenCode build 跑一遍但想确认它真用了我指定的 model，怎么 verify`
  - `我打算把 advisory 那一轮交给一个 fresh lane，按我配置的偏好应该具体怎么起`
  - `这个改 ipynb 第 3 个 cell 的活，能不能走 opencode 还是只能 lead_direct？`
  - `做一个 server-side fetch 的架构决策，应该让 oracle 来还是直接 Opus 来，哪个性价比更高`
  - `这种 explore 任务是用 Claude Code 的 Task subagent 还是 opencode orchestrator 划算？给我成本依据`
  - `找 monorepo 里所有 feature-flag 使用位置，按我配置应该选哪条路径，预计跑在什么模型上`
- **Precision failures:** none

### Runner 2 — `opencode-json` on `openai/gpt-5.4-mini`

- **Pass rate:** `8/20 (40%)`
- **Recall failures (12):**
  - `我现在打算起一个 review lane，按我个人路由偏好应该 fresh 起一个 OpenCode 还是 reuse implementer`
  - `我准备把这个 implementation 任务派出去，应该用 OpenCode 还是 Paseo，按我的偏好哪个更省 quota`
  - `你能不能给我一个明确的 route enum，决定下面这种长任务应该走 lead_direct / remote_sandbox / opencode_orchestrator 哪个`
  - `这个 feature 我应该在本地跑 pnpm test 还是丢 daytona sandbox 上跑，本地内存只有 16G`
  - `这种长链推理 + 高度模糊的 feature，是不是应该走 Claude Max 让我自己人工拉起`
  - `Gemini Flash 在我这个项目下能用来干啥，能写文件吗，写之前要不要 verification`
  - `我让 OpenCode build 跑一遍但想确认它真用了我指定的 model，怎么 verify`
  - `我打算把 advisory 那一轮交给一个 fresh lane，按我配置的偏好应该具体怎么起`
  - `这个改 ipynb 第 3 个 cell 的活，能不能走 opencode 还是只能 lead_direct？`
  - `做一个 server-side fetch 的架构决策，应该让 oracle 来还是直接 Opus 来，哪个性价比更高`
  - `这种 explore 任务是用 Claude Code 的 Task subagent 还是 opencode orchestrator 划算？给我成本依据`
  - `找 monorepo 里所有 feature-flag 使用位置，按我配置应该选哪条路径，预计跑在什么模型上`
- **Precision failures:** none

### Runner 3 — `codex-json` on codex default model

- **Pass rate:** `20/20 (100%)`
- **Recall failures:** none
- **Precision failures:** none

## 4. Cross-runner failure intersection

### Failed in all 3 runners

- None.

### Failed only in some runners

The following 12 queries failed in **`claude-stream` + `opencode-json`** but passed in **`codex-json`**:

- `我现在打算起一个 review lane，按我个人路由偏好应该 fresh 起一个 OpenCode 还是 reuse implementer`
- `我准备把这个 implementation 任务派出去，应该用 OpenCode 还是 Paseo，按我的偏好哪个更省 quota`
- `你能不能给我一个明确的 route enum，决定下面这种长任务应该走 lead_direct / remote_sandbox / opencode_orchestrator 哪个`
- `这个 feature 我应该在本地跑 pnpm test 还是丢 daytona sandbox 上跑，本地内存只有 16G`
- `这种长链推理 + 高度模糊的 feature，是不是应该走 Claude Max 让我自己人工拉起`
- `Gemini Flash 在我这个项目下能用来干啥，能写文件吗，写之前要不要 verification`
- `我让 OpenCode build 跑一遍但想确认它真用了我指定的 model，怎么 verify`
- `我打算把 advisory 那一轮交给一个 fresh lane，按我配置的偏好应该具体怎么起`
- `这个改 ipynb 第 3 个 cell 的活，能不能走 opencode 还是只能 lead_direct？`
- `做一个 server-side fetch 的架构决策，应该让 oracle 来还是直接 Opus 来，哪个性价比更高`
- `这种 explore 任务是用 Claude Code 的 Task subagent 还是 opencode orchestrator 划算？给我成本依据`
- `找 monorepo 里所有 feature-flag 使用位置，按我配置应该选哪条路径，预计跑在什么模型上`

Interpretation: this looks more like a **description coverage / phrasing sensitivity** issue than a broad semantic mismatch. Codex triggers fine; the other two under-trigger on the same cluster of route-selection prompts.

## 5. Recommendations

Do **not** apply these in this run; these are proposed next edits only.

1. **Add stronger trigger language for lane-routing jargon.**
   - Explicitly mention `review lane`, `advisory lane`, `fresh lane`, `reuse implementer`, `lead_direct`, `remote_sandbox`, `opencode_orchestrator`, and `route enum`.

2. **Add stronger trigger language for “which path on this machine?” questions.**
   - Current description covers model/runtime choice in general, but the misses show under-triggering for phrases like “按我配置/按我偏好应该选哪条路径”.

3. **Call out local-vs-remote resource routing more directly.**
   - Add explicit examples like local memory limits, `Daytona sandbox`, `本地还是远程`, `本地跑还是丢 sandbox`.

4. **Call out verification / pinning / effective-model confirmation.**
   - Add keywords like `verify`, `确认用了哪个 model`, `pinned model`, `effective provider/model`.

5. **Call out host-bound-tool exceptions.**
   - Add `ipynb`, notebook cell edits, and similar cases where Claude Code lead/tooling may beat OpenCode.

6. **Call out human-triggered Claude Max escalation more directly.**
   - The miss on “Claude Max 让我自己人工拉起” suggests the current wording is still too indirect.

7. **Add a cost-language cluster.**
   - Include `划算`, `性价比`, `更省 quota`, `成本依据`, since those appear in multiple misses.

8. **Consider one Chinese-heavy trigger sentence.**
   - The description already includes some Chinese, but the miss set is dominated by Chinese route-selection phrasing. A denser sentence focused on “按我配置/按我偏好/选哪条路径/跑在什么模型上” may help the weaker runners.

## 6. Final list of files changed

- `/Users/fanye/.local/share/chezmoi/home/dot_agents/skills/personalized-agent-config/SKILL.md` — added tier-level Capability column, baseline note, implication note, and a short Opus orchestration mention.
- `/Users/fanye/.local/share/chezmoi/home/dot_agents/skills/personalized-agent-config/references/model-cost-map.md` — added per-model Capability column, benchmark-disclaimer text, implication note, and a short Opus orchestration note.
- `/Users/fanye/.claude/plugins/marketplaces/my-claude-plugins/docs/skill-redesign/2026-05-13-multi-runner-eval.md` — wrote this change + eval report.

## 7. Round 2 — description tightening

### Description delta

**Before**

> MUST be loaded for any routing, runtime, or model-selection decision on this
> machine. Use when choosing between Claude Code, `opencode run --agent
> orchestrator`, `opencode run --agent build --model <provider/model>`, a remote
> sandbox, or recommending human-triggered Claude Code; when weighing Claude
> Opus / Sonnet / GPT-5.5 / GPT-5.4 / gpt-5.3-codex-spark / Gemini / GLM on cost
> vs fit; when deciding local vs remote execution; or whenever the user asks
> 'should I use X or Y' / 'which model' / 'which is cheaper' / '哪个划算' /
> '本地还是远程' / 'OpenCode 还是 Claude' / 'opus 还是 codex'.

**After (tested, then reverted due precision regression)**

> MUST be loaded for any routing, runtime, or model-selection decision on this
> machine. [same opening text omitted for brevity] 也用于按我偏好/按我配置判断选哪条路径/
> 走哪条路径、哪个划算/性价比/成本依据、跑在什么模型上、验证用了哪个 model、以及
> 本地还是远程/本地跑还是丢 sandbox；命中 review lane / advisory lane / fresh lane /
> reuse implementer / route enum / lead_direct / remote_sandbox /
> opencode_orchestrator 之类路由话术，含 ipynb / notebook cell edits 这类
> host-bound-tool 例外，以及“走 Claude Max 让我人工拉起”/“需要 Claude Max”/
> “升级到 Claude Max”。

### Pass rates after tightening

- `claude-stream` via `glm-claude`: `8/20 (40%)`, delta vs round 1: `0pp`
- `opencode-json` on `openai/gpt-5.4-mini`: `8/20 (40%)`, delta vs round 1: `0pp`
- `codex-json` on codex default: `18/20 (90%)`, delta vs round 1: `-10pp`

### Remaining recall failures (intersection across runners)

- None.

### Precision check

New precision failures appeared on `codex-json` only:

- `OpenCode SSE 在 idle 之前 close 了怎么 recover`
- `exec-plan 里 feature-2 怎么 parse 出来`

`claude-stream` and `opencode-json` remained at `0` precision failures.

### Verdict

This tightening is **not** production-ready. It produced no recall gain on the two weak runners and regressed codex precision from `20/20` to `18/20`, so I backed the description change out after measuring round 2. The remaining misses now look more structural to runner priors / trigger-discovery behavior than to missing keywords alone.
