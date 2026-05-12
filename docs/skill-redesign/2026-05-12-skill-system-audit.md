# 2026-05-12 Skill System Audit

## 1. Skill 清单与归属

当前自有 Skill 其实分成四类：①通用流程/编排（`agentic-orchestration`、`task-iteration`、`personalized-agent-config`）；②runtime 适配器（`opencode-companion`、`paseo-companion`、`daytona-companion`、`mcp-skill`）；③领域工作流（`debug-workflow`）；④仓库内但本质是外部封装的 wrapper（`google-workspace`）。另有一个关键迁移信号：`skills/opencode-orchestrator/` 仍是 git tracked 路径，但工作树里已被整目录删除；同时 `skills/agentic-orchestration/` 已存在但目前还是未跟踪目录，说明“把 OpenCode 特定 team-lead 手册抽成通用编排层”的重构意图已经开始，但尚未在 git 层完成落地（`git status --short`，`git ls-files "skills/*/SKILL.md"`）。

| 名称 | 角色定位 | 触发条件与误/漏触发判断 | 依赖关系 | 物理位置 | references / scripts / eval |
|---|---|---|---|---|---|
| `agentic-orchestration` | 通用 lead/lane 编排规则 | 描述很清楚，覆盖多步 agentic work、acceptance gates、review independence（`skills/agentic-orchestration/SKILL.md:1-4`）；偏 broad，容易对任何“多步任务”过度吸附，但作为 process skill 可接受 | 无 runtime 绑定；显式要求另加载本地 runtime profile（`119-123`） | 仓库 `skills/agentic-orchestration/`，**当前未 git tracked** | refs: 无；scripts: 无；eval: 无 |
| `opencode-orchestrator`（legacy, D） | 旧的 OpenCode 本地 TL 手册 | 触发器直接写 team-lead / manager / orchestrator / direct Companion execution（删除前 `SKILL.md:1-4,49-57`）；强，但把“通用编排”与“OpenCode 默认本地执行”绑死 | 依赖 `opencode-companion`，可选 `daytona-companion`（`11-16,61-63`） | 仓库 tracked，**当前工作树删除** | refs: `references/daytona-remote-lane.md`；scripts: `check-opencode-snapshot.sh`；eval: 无 |
| `opencode-companion` | OpenCode runtime 生命周期适配器 | 触发器覆盖 session/status/serve/rescue/attach/background 等生命周期语义（`skills/opencode-companion/SKILL.md:1-4`）；高精度，但也承载了不少本机 routing 偏置 | 依赖 skill-local Node 脚本、OpenCode serve、工作目录；引用多个 reference（`11-17,135-145`） | 仓库 tracked | refs: 有；scripts: 有；eval: **有** `eval/opencode/*`，含 `skill_name: opencode-companion` 与 trigger-eval（`eval/opencode/evals/evals.json:1-71`） |
| `paseo-companion` | Paseo CLI / daemon / agent 管理适配器 | 触发器是所有 paseo 关键词、agent ids、loop、schedule、terminal、host/port（`skills/paseo-companion/SKILL.md:1-4`）；高精度，漏触发风险低 | 依赖 `paseo` CLI / daemon；大量 references（`127-139`） | 仓库 tracked | refs: 有；scripts: 无；eval: 无 |
| `daytona-companion` | Daytona sandbox 生命周期适配器 | 触发器围绕 sandbox up/status/push/exec/pull/down/preview/smoke-test（`skills/daytona-companion/SKILL.md:1-4`）；精度高，但对“泛 remote sandbox”表达仍偏 Daytona 命令面 | 依赖 `daytona-manager.mjs`、Daytona 状态根目录、可选 remote Paseo/OpenCode（`11-17,63-80,102-110`） | 仓库 tracked | refs: 有；scripts: 有；eval: **仅脚本单测** `eval/daytona/tests/unit/daytona-manager.test.mjs`，无 skill trigger/outcome eval |
| `task-iteration` | exec-plan 驱动的 Plan→Generate→Evaluate 循环 | 描述只强触发“exec-plan document / feature or bounded project”（`skills/task-iteration/SKILL.md:1-4`）；精度高，但对“implementation plan / checklist 执行”这类近义说法有漏触发风险 | 依赖 `agentic-orchestration` + runtime profile；读 `references/exec-plan-parsing.md` 与 `prompt-templates.md`（`21-22,81-84,124-145`） | 仓库 tracked | refs: 有；scripts: 无；eval: 无 |
| `debug-workflow` | 以“可复现性判定”为核心的调试路由器 | 描述聚焦 browser/UI/Web3 reproduction（`skills/debug-workflow/SKILL.md:1-4`）；对前端 lane 很强，但 backend/API/debug 只在正文承认“未来要加”，因此 backend 调试容易漏触发或过度承诺（`11-16,32-38`） | 依赖 Playwright/browser MCP/agent-wallet lane；`templates/repro-report.md`（`34-37,109-120`） | 仓库 tracked | refs: 有；templates: 有；scripts: 无；eval: 无 |
| `mcp-skill` | 按需调用 MCPorter 的轻量包装 | frontmatter 只有一句“Use MCPorter...” （`skills/mcp-skill/SKILL.md:1-4`）；明显过弱，正文里真正能力范围是 browser/docs/repo/web search（`8-26`），很容易漏触发 | 依赖 `mcporter` 和 `~/.mcporter/mcporter.json`（`18-25`） | 仓库 tracked | refs: 无；scripts: 无；eval: 无 |
| `google-workspace` | `gws` CLI 的 Google Docs/Workspace wrapper | 描述很强，包含 URL / Doc ID / GDoc / gws docs 等触发词（`skills/google-workspace/SKILL.md:1-4`）；精度高，但本质是外部 CLI 封装，不宜列入重设计主目标 | 依赖 `gws` CLI 与 Python helper（`13-18,63-66,114`） | 仓库 tracked | refs: 有；scripts: 有；eval: 无；且 `scripts/` 下出现 `__pycache__`/示例文件迹象，说明 source tree cleanliness 还有瑕疵（来自 `skills/*/scripts/**/*` 清单） |
| `personalized-agent-config` | 本机 runtime / quota / routing 策略 | 描述强，明确“before orchestration / runtime selection / quota-aware model routing”（`~/.local/share/chezmoi/.../SKILL.md:1-4`）；精度高，但范围很大，可能吞掉本应由场景 preset 表达的选择 | 依赖动态快照脚本 `context-snapshot.sh`、oh-my-opencode-slim 配置、codexbar、Daytona 状态缓存（`13-25,38-48,49-63`；脚本 `1-285`） | **chezmoi tracked**：源在 `/Users/fanye/.local/share/chezmoi/...`，运行态暴露到 `~/.agents/skills/...` | refs: 无；scripts: 有；eval: 无 |

### 外部存量（只列范围，不作为本次重设计主目标）

这些 skill 更多是外部系统/CLI 能力封装，而不是你自己的 routing/skill-architecture 设计面：

| 名称 | 一句话用途 |
|---|---|
| `lark-*` | 飞书全家桶封装：IM、日历、Base、Docs、Mail、Minutes、VC、Wiki 等 |
| `docx` | Word `.docx` 创建、编辑、排版与替换 |
| `gh-cli` | GitHub CLI 操作参考与命令面 |
| `chatgpt-apps` | ChatGPT Apps SDK / MCP server + widget 构建 |
| `use-railway` | Railway 项目、服务、数据库、域名与部署运维 |
| `google-workspace` | 虽然在本仓库中，但设计形态也属于“外部 CLI wrapper”这一类 |

## 2. 当前的“路由层 / 通用层 / 执行层”分布

现在的结构已经有三层雏形，但边界仍不干净。**通用法则层**主要是上游 `using-superpowers` 的“先判 skill，再行动”规则，以及你新拆出来的 `agentic-orchestration`（lead/lane、acceptance、independence）和 `task-iteration`（Plan→Generate→Evaluate 相位机）；`debug-workflow` 也带一点 process router 味道，因为它先判定 reproducibility，再决定 lane（`using-superpowers/SKILL.md:44-46`，`agentic-orchestration:31-46`，`task-iteration:23-47`，`debug-workflow:18-38`）。**路由/编排层**主要是 `personalized-agent-config`，它把本机事实、quota、remote cache、OpenCode slim 配置、决策程序揉在一起；已删除的 `opencode-orchestrator` 以前也扮演这一层，只是同时夹带了 OpenCode 偏好（`personalized-agent-config:27-63`，legacy `opencode-orchestrator:49-63`）。

**执行/适配器层**则是 `opencode-companion`、`paseo-companion`、`daytona-companion`、`mcp-skill`：它们分别包装 OpenCode、Paseo、Daytona、MCPorter 的具体命令面。但三者重叠明显：`daytona-companion` 负责 remote sandbox 生命周期，却又指导如何 bootstrap remote Paseo/OpenCode（`63-80`）；`paseo-companion` 负责 agent/daemon/worktree/loop；`opencode-companion` 又在 skill 正文里写入了“本机 team-lead 时优先 direct companion script”的 routing 偏置，甚至给出硬编码模型示例（`30-47,82-101`）。这导致“谁负责**选** runtime、谁负责**跑** runtime、谁负责**解释** internal role”仍有交叉。当前最容易混淆的一组边界就是：`agentic-orchestration` 负责抽象 lane contract，`personalized-agent-config` 负责本机选择策略，`opencode/paseo/daytona` 只该做 adapter；但实际文本里 adapter 仍在做 policy。 

## 3. 与 superpowers 设计原则的差距

上游 `using-superpowers` 的核心原则可浓缩成四条：**强触发**（1% 可能相关就先 load skill）、**渐进披露**（metadata → SKILL.md → references）、**用户指令优先**、**跨平台适配**（不同 host 要有 tool mapping）（`using-superpowers/SKILL.md:10-16,18-26,38-46`；并通过 `references/copilot-tools.md` / `codex-tools.md` / `gemini-tools.md` 承接）。按这把尺子看，你的 repo-owned skills 里，`agentic-orchestration`、`task-iteration`、`opencode-companion` 对齐度最高：description 强、正文不太胖、会把细节导向 references、并显式强调 runtime-neutral 或 host-background mapping（`agentic-orchestration:119-123`，`task-iteration:21-22,228-235`，`opencode-companion:21-29,135-145`）。

主要差距有三类。第一类是**description 过弱**：`mcp-skill` frontmatter 只有一句 MCPorter 概述，没把正文中的 browser/docs/search/repo 场景抬到 description，典型 undertrigger（`mcp-skill:1-4,8-26`）；`task-iteration` 只写 `exec-plan`，对“执行 implementation plan / checklist”这类近义请求召回偏低。第二类是**正文装了太多命令参考**：`google-workspace`、`mcp-skill` 仍偏“命令手册”，尤其 `google-workspace` 把大量 Google Docs 命令直接塞进 SKILL 主体（`13-125`），不够符合“按需放 references”的设计。第三类是**跨平台/宿主说明不均匀**：`opencode-companion` 做得最好；`daytona-companion`、`paseo-companion` 基本是 CLI 中立但缺少显式 host 行为说明；`mcp-skill` 仍明显写给 OpenCode（提 `opencode.json`），跨宿主适配几乎没有。`personalized-agent-config` 的问题不是 trigger，而是把 snapshot、stable facts、policy、prompt contract 全塞在一个 178 行文件里，虽然没超大，但已经开始侵蚀 progressive disclosure。

### 对齐度速评

| Skill | 对齐度 | 原因 |
|---|---|---|
| `agentic-orchestration` | 高 | trigger 强，runtime-neutral，边界意识清楚 |
| `task-iteration` | 高-中 | 相位机清晰、refs 使用好；但 trigger 语义略窄 |
| `opencode-companion` | 高 | refs 丰富，明确 host-background 映射；但混入本机 routing 偏置 |
| `paseo-companion` | 中高 | command/reference 分层不错；缺少更显式的 host/tool 适配说明 |
| `daytona-companion` | 中高 | refs 化较好；但仍含一部分 runtime policy 指导 |
| `debug-workflow` | 中 | router 思路好；backend lane 还停留在“以后加”，覆盖面与 description 不完全对齐 |
| `personalized-agent-config` | 中 | 强 trigger、强本机事实；但单文件承载过多层次，容易陈旧 |
| `mcp-skill` | 低 | description 太弱、正文像命令手册、无 refs/跨平台适配 |
| `google-workspace` | 中 | 触发强，但本质是 wrapper，正文过重，不适合作为架构设计模板 |
| `opencode-orchestrator`（legacy） | 低-中 | 旧 skill 把通用编排和 OpenCode 本地默认绑在一起，正是当前要拆的对象 |

## 4. 与 oh-my-opencode-slim 路由设计的差距

`oh-my-opencode-slim` 的配置抽象是非常清楚的：**role**（orchestrator/oracle/explorer...）负责语义分工，**preset** 负责一组 role→model 映射，**fallback** 负责 provider 链，**council** 负责多模型会商；当前本机实际配置 `~/.config/opencode/oh-my-opencode-slim.json` 也遵守这个结构，活跃 preset 是 `my-mix`，另有 `fallback.chains` 和 `council.presets`（README `68-104`；schema `202-260,602-741`；本机配置 `1-111`）。这意味着“运行时的真实模型/回退/会商结构”已经有一个机器可读真源，不应再在 skill prose 里重复硬编码太多。

`personalized-agent-config` 已经迈出正确一步：它明确说 external caller 不要直接调 slim internal roles，应该以 lane role 语义描述，并用 `orchestrator` / `build --model` 两个外部入口表达（`40-48,92-115`）。这和 slim 的角色抽象是对齐的。但它与 slim 的差距有两点。第一，**它仍在文本里硬编码 provider/model/quota policy**：例如 GPT Pro/Codex、Gemini Flash、GLM overflow 的分工都写死在 `Stable Facts` 里（`29-37`）。这在“本机事实”上合理，但一旦 `oh-my-opencode-slim.json` 换 preset，SKILL 文本就会漂移。第二，**它没有像 slim 一样提供按场景可切换的 preset 概念**。当前只有决策程序：lead-direct / remote sandbox / orchestrator / pinned model / Claude Code（`49-63`），但没有显式“探索预设 / 实现预设 / 独立审核预设”命名层，导致复用时仍要重新读整段 policy。

边界上，目标其实已经写得很清楚：公共 skill 定义 role split，个性化 skill 定义本机事实；但落地还不彻底。`agentic-orchestration` 和 `personalized-agent-config` 都重复了 prompt contract、review/fix principles；`opencode-companion` 还继续放着 machine-specific bias 与具体 `--model openai/gpt-5.4` 示例（`82-101`）。所以当前不是“没拆层”，而是“拆了，但 adapter 层还在漏 policy，personal layer 也还没升格为 preset layer”。

## 5. 系统性效果评估的缺口

仓库规范已经要求所有测试/eval 放 `eval/<name>/`（`CLAUDE.md:20-26`），但 skill 侧只有 `opencode-companion` 真正形成了“触发 + 行为断言”样例：`eval/opencode/evals/evals.json` 里已经有 `skill_name`、prompt、expected_output、behavioral assertions，另有 `trigger-eval.json` 做 should-trigger / should-not-trigger（`eval/opencode/evals/evals.json:1-71`，`trigger-eval.json:1-23`）。`daytona` 目前只有脚本单测，其他 skill 基本没有 trigger/outcome/routing 三类闭环。这意味着现在能验证“脚本函数是否工作”，但不能系统验证“skill 有没有被正确触发、触发后有没有走对 references/runtime/policy”。

最小可行框架建议分三层。**触发评估**：给每个自有 skill 一份 `eval/<skill>/evals/trigger-eval.json`，沿用 skill-creator 的 query/should_trigger 结构，统计 precision/recall；重点做 near-miss negatives，而不是明显无关提示。**效果评估**：给每个 skill 一份 `evals/evals.json`，包含 prompt、expected_output、assertions，检查是否调用了正确 references、输出形状是否符合 output_contract、runtime 是否正确（例如 OpenCode 该走 `orchestrator` 还是 `build --model`，Paseo 该 `attach` 还是 `run`）。**路由准确性评估**：专门给 `personalized-agent-config` 做 decision-table fixture：输入=用户 prompt + snapshot 条件，输出=期望 route enum（`lead_direct` / `remote_sandbox` / `opencode_orchestrator` / `opencode_build_pinned` / `human_claude_code_only`）。

关于 harness，**优先复用 skill-creator 的数据模型与评分思路，而不是一上来复用整套人审 viewer 工作流**。原因很简单：repo 里 skill-creator 还只是设计/计划，尚未 vendored 落地（`docs/superpowers/specs/2026-05-12-skill-creator-runner-support-design.md:5-12,31-38,61-97`）；它完整 loop 偏重、依赖浏览器/子代理/benchmark viewer，不适合先做 MVP。最省事的脚手架是：一个 runner 脚本（Python/Node 皆可）+ 一个 judge prompt + 期望 JSON schema。等 skill-creator 真进仓库后，再把现有 eval JSON 迁到它的 schemas/runner 上即可。

## 6. 设计优化的几个候选方向（只列选项）

下面这些方向有的互补，有的互斥，但都比“继续在 companion skill 里加更多 policy 段落”更健康。

| 选项 | 一句话定位 | 受影响 skill | 预期收益 | 主要风险 | 推荐度 |
|---|---|---|---|---|---|
| A. 完成 `opencode-orchestrator` → `agentic-orchestration` 迁移 | 把旧 OpenCode 专属 TL 手册彻底抽成通用编排层 | `opencode-orchestrator`, `agentic-orchestration`, `opencode-companion` | 消除旧名遗留，边界更清楚 | 兼容旧引用/旧习惯可能断裂 | **高**：这是当前工作树已经在做的事，应先收口 |
| B. 拆分 `personalized-agent-config` 为 `stable-facts` + `dynamic-snapshot` + `decision-policy` | 把“会变的事实”和“不会变的原则”分开 | `personalized-agent-config` | 降低文本陈旧风险，便于把 snapshot 结果机读化 | 文件数上升，初次阅读成本增加 | **高**：最能缓解当前一文件承载过重问题 |
| C. 新增 `routing-presets` 层 | 用 `explore / implement / review / advisory` 这类场景 preset 表达路由 | `personalized-agent-config`, `agentic-orchestration` | 更接近 slim 的 preset 思路，减少每次重新解释 policy | 新增一层概念，若命名不好会更绕 | **高**：能把“策略文本”变成可复用决策接口 |
| D. runtime adapters 共享一份“边界契约” | 把 `opencode/daytona/paseo` 共同的 reuse / timeout / host-background / acceptance 规则抽公共 reference | `opencode-companion`, `paseo-companion`, `daytona-companion` | 减少重复段落，adapter 更专注命令差异 | 若抽得过度，可能丢失各 CLI 独特坑点 | **中高**：适合在 A 完成后做第二步 |
| E. 每个自有 skill 强制配套 `trigger + outcome (+ routing)` eval | 把 skill 当产品而不是纯文档 | 所有自有 skill | 触发质量、路由正确性、回归漂移都可观测 | 前期写 eval 成本明显上升 | **高**：没有这个，后续重设计只能凭感觉 |

## 7. 立即可做的几个低风险清理项

这些都属于单文件级别，影响直观，且不需要先拍板大重构。

| 动作 | 文件 | 影响 | 工作量 | 说明 |
|---|---|---:|---:|---|
| 强化 `mcp-skill` description，把 browser/docs/repo/web-search 场景抬到 frontmatter | `skills/mcp-skill/SKILL.md` | 5/5 | 1/5 | 这是当前最明显的 undertrigger 点 |
| 把 `task-iteration` 的触发描述从 `exec-plan` 扩到 implementation plan / checklist execution | `skills/task-iteration/SKILL.md` | 4/5 | 1/5 | 能显著补召回，而不必改主体流程 |
| 从 `opencode-companion` 删掉或下放 machine-specific `--model openai/gpt-5.4` 推荐段 | `skills/opencode-companion/SKILL.md` | 4/5 | 2/5 | 避免 adapter 再次承载 routing policy |
| 把 `debug-workflow` description 明确成“当前已实装 frontend/browser/Web3 lane，backend lane 仅 blocker 模式” | `skills/debug-workflow/SKILL.md` | 3/5 | 1/5 | 降低 backend 调试误预期 |
| 把 `personalized-agent-config` 里最容易陈旧的 provider prose 改成引用 snapshot/config 的表达 | `~/.local/share/chezmoi/.../personalized-agent-config/SKILL.md` | 5/5 | 2/5 | 文本不再与 `oh-my-opencode-slim.json` 双写漂移 |
| 给 `paseo-companion` 增一段“此 skill 只讲 CLI adapter，不负责 runtime 选择” | `skills/paseo-companion/SKILL.md` | 3/5 | 1/5 | 进一步切干净与 personalized policy 的边界 |
| 给 `daytona-companion` 增一段“选择 remote 与否由 routing 层决定” | `skills/daytona-companion/SKILL.md` | 3/5 | 1/5 | 防止 sandbox adapter 继续长出 routing 意见 |
| 给 `agentic-orchestration` 增一个显式“历史替代 `opencode-orchestrator`”兼容说明 | `skills/agentic-orchestration/SKILL.md` | 3/5 | 1/5 | 帮用户理解迁移路径，减少语义断层 |
| 把 `google-workspace` 主体中过长命令手册进一步压到 references | `skills/google-workspace/SKILL.md` | 2/5 | 2/5 | 不是主战场，但有助于树立更一致的 skill 形态 |
| 移除 skill 源树里的测试/编译残留迹象 | `skills/daytona-companion/scripts/daytona-manager.test.mjs` / `skills/google-workspace/scripts/...` | 4/5 | 2/5 | 与仓库“eval 统一进 `eval/`”规则对齐；这里虽涉移动/清理，但仍是很低风险的卫生项 |

## 跳过项 / 不确定点 / 需要用户决策

- 我没有逐个深读所有外部存量 skill（尤其 `lark-*`），只按“外部封装家族”做了范围归类。
- 我没有实际运行 `context-snapshot.sh`、OpenCode、Paseo、Daytona 或 MCPorter；所有判断基于 skill 文本、配置和 eval 结构，不是 runtime reachability 验证。
- 我没有完整通读每个 reference 文件；本报告主要审计顶层 SKILL、脚本/refs 目录形态、以及少量关键辅助文档。
- `agentic-orchestration` 当前在工作树里未 git tracked，这意味着“它是否真要替代 `opencode-orchestrator`”虽然从删除/新增状态上看几乎确定，但仍属于**待提交的重构意图**，不是已完成事实。
- `google-workspace` 是否继续留在“自有 skill 列表”还是拆成独立 plugin，只能由用户决定；从设计纯度看我更倾向后者。
- 是否要保留 `opencode-orchestrator` 兼容壳（alias / migration note），也需要用户拍板；这会直接影响重命名/清理策略。

## 给 TL 的要点摘要

当前体系已经从“单个 `opencode-orchestrator` 大总管”转向“通用编排 + 本机路由 + runtime adapter”三层，但拆层未收口：`agentic-orchestration` 还没入 git，`opencode-companion` 仍夹带路由 policy，`personalized-agent-config` 还缺 scene preset 抽象。下一步最值当的是：先完成旧 skill 迁移，再把 personalized policy 拆出 stable/dynamic/preset 三层，同时给每个自有 skill 补 trigger/outcome/routing eval。 
