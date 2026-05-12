# 2026-05-12 Skill Redesign Plan Independent Review

## 1. 设计正确性

- **BLOCKING**：计划仍把“runtime adapter 示例”与“本机 policy”混在一起。A 只点名 `opencode-companion` 三段，但当前 public references 里还有 `daytona-companion/references/remote-agent-runtime.md` 与 `paseo-companion/references/remote-host-orchestration.md` 的硬编码 `--model openai/gpt-5.4`。这不是单纯示例问题，而是 adapter 在暗示 provider/model 选择；必须统一改成 `<provider/model>`，并明确“模型由 routing profile 决定”。
- **STRONG**：C 的 scene presets 方向正确，但现在定义仍偏“说明文”。如果 presets 不能输出稳定 route enum、默认 runtime、允许写范围、验证门槛和 fallback 条件，就只是给旧 policy 换标题，不能解决 slim 风格 preset 缺失。建议把五个 preset 做成半结构化表格，供 eval 直接断言。
- **STRONG**：`agentic-orchestration` 加 migration note 可行，但不要写成“OpenCode orchestrator 的替代实现”。应写成“通用编排层替代 legacy OpenCode-specific orchestration guidance”，避免公共原则层重新绑定 OpenCode 历史。

## 2. 去个性化是否彻底

- **BLOCKING**：E 的 grep 条件不够。除了 `this machine/Link/Hermes/fanye`，还应扫 `openai/gpt-5.4`、`Claude Max`、`GPT Pro`、`Mac mini`、`/Users/`、具体 host/port、sandbox id、subscription/quota 等。硬编码模型和订阅事实即使不含姓名，也属于个性化 routing policy。
- **STRONG**：计划未覆盖 references 的隐性泄漏风险。public skill 正文清了不够，`references/` 往往更容易藏“我这台机器上验证过”“默认 provider”或绝对路径。验收应递归扫 `skills/**`，并人工读 companion 的 remote/runtime references。
- **NIT**：`task-iteration`、`agentic-orchestration` 的示例 prompt 若出现“默认 OpenCode/remote/Claude Max”措辞，也应改为 lane-neutral；公共 skill 可以说“consult routing profile”，不要给偏好。

## 3. evaluation 框架可执行性

- **BLOCKING**：`run_eval.py` 只有 `claude-stream/codex-json/opencode-json` 三种 detector。最干净方案不是虚构 `glm-claude-code` runner，而是保留 `--runner-mode claude-stream`，用 `--runner-command` 指向一个普通可执行 wrapper，让 wrapper 内部调用 `glm claude -p ... --output-format stream-json --verbose ...`。如果直接 `source ~/.zshrc && glm ...`，会依赖交互 shell 函数、并发 worker 下更脆；物化 wrapper 更可复现、CI 也更容易挂载环境变量。代价是要维护一个小脚本，但比把 zsh 函数塞进 eval helper 稳。
- **STRONG**：一次给 8 个 skill + personalized 全铺 outcome eval 太重，容易生成大量低质量骨架。建议先做 3 个旗舰：`opencode-companion`（已有基线）、`personalized-agent-config`（routing eval 最关键）、`mcp-skill`（description undertrigger 风险最高）；其余只先铺 trigger near-miss，等 runner 稳定再补 outcome。
- **STRONG**：`eval/<skill>/tests/smoke.sh` 方向符合“eval 下放测试”的仓库原则，但与现有 `eval/opencode/tests/integration/*.test.mjs` 不完全一致。若要 shell smoke，建议统一 `eval/<skill>/tests/smoke.sh` 并在 README 说明；否则 opencode 继续用 vitest integration，daytona/paseo 用 shell，会让 CI 入口分裂。

## 4. 执行顺序与风险

- **BLOCKING**：应先建隔离分支或 worktree，再改 public marketplace 与 chezmoi 两棵树。该计划同时改仓库、个人 chezmoi、eval helper、README；任何一步中断都可能留下“公共 skill 已去 policy，但 personalized 尚未承接”的半迁移状态。
- **STRONG**：顺序应调整为“建隔离 → 完成泄漏扫描清单 → adapter 去 policy → personalized 承接 → eval runner MVP → 扩展 eval”。现在 D 太晚，导致 B/C 的 trigger 改写没有立即回归验证。
- **NIT**：可并行的部分：A 的 public 清理、B 的 description/boundary 小改、C 的 personalized references 草案可分 lane；D 的 runner wrapper 应先串行打通，再并行写 eval 数据。

## 如果只接受 3 条 BLOCKING 修改

1. 扩大去个性化范围到 `skills/**/references/**`，删除/参数化所有硬编码模型、订阅、主机、绝对路径与本机验证措辞。
2. 把 GLM eval 路径定义为 `claude-stream` detector + 普通 wrapper 可执行文件，不新增不存在的 runner mode，也不依赖 `~/.zshrc` 函数。
3. 先在隔离分支/worktree 中按“adapter 去 policy → personalized 承接 → runner MVP 验证”顺序落地，避免半迁移污染 public marketplace。
