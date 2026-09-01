# UPSTREAM · Paseo 产品侧缺口

派发书要求（`tasks/active/paseo-companion-manager-skill-20260808/DISPATCH.md` §2/§4）：
凡是 Skill/服务覆盖不了、必须 Paseo 产品本身做的能力，单列在这里，不要在 Skill 或
`skills/agent-runtime-control-panel/runtime` 里假装做到了。每条都附实测证据，全部通过公开
`paseo <cmd> --json` 黑盒验证得出（见 [feedback_paseo_cli_blackbox_only]），
没有读任何内部实现源码。

---

## 1. 子 agent 终态没有主动 push 给 parent 的机制（PROPOSAL §1.2，最核心的缺口）

**现状**：没有任何 flag / webhook / event stream 能让 daemon 在子 agent 进入 idle /
error / 传输断开等终态时主动通知 parent。`paseo hooks <agent> <event>` 是"记录 hook
活动"的写入口，不是回调注册。

**影响**：这是 PROPOSAL §1 反向检查（"系统可断言至少有一个活着的唤醒源"）在纯客户端/
纯服务侧永远做不到"事件驱动、零延迟"的根本原因。任何客户端只能靠轮询 + 对账循环把它
降级成"有界延迟（分钟级）能发现"，不是消除；`skills/agent-runtime-control-panel/runtime`
用 `ls -g --json` + `inspect --json` 的有界对账循环做这件事。

**请求**：`paseo run` 增加类似 `--notify-parent-on-terminal` 的选项，或提供一个
可订阅的 agent 生命周期事件流（哪怕只是本机 SSE/WS 长连接）。

---

## 2. `paseo heartbeat` 没有 `ls`/`inspect`

**现状**：只有 `create` / `update` / `delete` 三个子命令。已知 id 时唯一能反查真实状态
的手段是 `paseo heartbeat update <id> --cron <原样传入不变的值> --json`——传相同值
等价于只读探测，能拿回 `status/nextRunAt/lastRunAt`，但这是未文档化的副作用用法，
不是正式契约。**没有任何手段枚举"当前有哪些 heartbeat 指向我"**——任何依赖 heartbeat
的调用方都必须自己维护一份本地记录（write-ahead + 启动时对账），而这份记录一旦随进程
丢失就会留下"孤儿 heartbeat"：daemon 里的排程还在跑，本地却不知道它存在。ARCP 不使用
heartbeat 投递，正是因为这条缺口没有可核实的对账面。

**请求**：加 `paseo heartbeat ls [--target-agent <id>]` 和
`paseo heartbeat inspect <id>`，把 `update` 的探测副作用变成正式只读接口。

---

## 3. `--max-runs 1` 的一次性提醒在目标 agent 忙时会被吞、不重试

**现状**（上一轮通过读 daemon 源码定位，本轮确认可以纯 CLI 黑盒复现）：如果一次性
心跳恰好在目标 agent 有回合在跑时触发，会失败且不重试，直接计入 `maxRuns`、
schedule 变 `completed`，这条提醒永远不会送达，且没有任何人被通知。

**黑盒复现路径**：给一条重复 cron 的心跳投递失败之后，`lastRunAt` 仍然前进但目标
agent 没有收到消息（没有 ack）——这个"投递过但没送达"的模式是可观测的。

**影响**：`--max-runs 1` 不能用来表达"这条一定要送到"。可行的绕过是重复 cron +
`--expires-in` 做 at-least-once 直到显式确认；ARCP 改为完全不依赖 heartbeat 投递，
用安全点 Delivery 加持久 ChannelEvent 表达同一件事。

**请求**：忙时触发的一次性/定时投递应该重试或顺延，而不是静默计入完成次数。

---

## 4. `paseo inspect --json` 不回显 label（写读不对称）

**现状**：`paseo agent update <id> --label k=v` 能成功设置 label，且
`paseo ls --label k=v --json` / `paseo ls -g --label k=v --json` 能用它过滤查询到，
但 `paseo inspect <id> --json` 的输出里完全没有 label 字段。

**影响**：label 只能当"存在性信号"（能不能被过滤查到），不能当"内容存储"用——权威记录
必须落在调用方自己的持久状态里（ARCP 用 Knowledge / Result / ChannelEvent），label 只是
尽力而为的可视化镜像，会漂移的一侧永远是 label 不是权威记录。

**请求**：`inspect --json` 补上 `Labels` 字段。

---

## 5. `paseo ls --json` 默认按调用者当前 cwd 过滤，且不返回 `ParentAgentId`/label

**现状**：`paseo ls --json` 默认只列当前 cwd 下的 agent；必须显式加 `-g` 才是全局。
`ls -g --json` 返回的每一项不含 `ParentAgentId`，也不含 label，`created` 字段是
`"38 minutes ago"` 这种人话字符串而不是时间戳。

**影响**："枚举我 spawn 的子 agent"必然是 `ls -g` 拿全量候选 + 逐个 `inspect` 的
N+1 模式。本机实测 73 个候选、8 并发上限下单次 `/children` 请求约 9-11 秒——
这个延迟会随候选总数（不止是自己的子 agent数，是**全机器**的 agent 总数）线性增长。

**请求**：`ls`/`ls -g` 支持 `--parent <id>` 服务端过滤，或者干脆在列表项里直接带上
`ParentAgentId`，省掉客户端的 N+1 fan-out。

---

## 6. `paseo logs` 没有 `--json`，`--tail <n>` 未按预期截断

**现状**：`paseo logs <id> --tail 2` 实测仍返回远多于 2 行的输出；根级 `--json`
对 `logs` 不生效，输出始终是给人看的 `[Bash] ...` 格式。

**影响**：PROPOSAL §2 的巡检简报（"这段时间提交了什么、有没有裸奔的改动"）没法从
Paseo 侧机器可读地获取。`skills/agent-runtime-control-panel/runtime` 的 panorama/runtime
status 因此直接对子 agent 的 cwd 读 commit 与 diffstat，绕开了 Paseo；等 `logs` 支持
`--json` 后应该整块替换。

**请求**：`logs --json` 输出结构化的活动记录（含 shell 命令、退出码、时间戳），
`--tail` 语义修正为真的只返回最后 N 条。

---

## 7.（附带发现，不是本轮核心，但值得记）`paseo run --cwd` 单独传会被静默忽略

**现状**：从一个 agent-scoped 的调用者（自身也是 Paseo agent、`PASEO_AGENT_ID` 已设置）
发起 `paseo run --cwd <path>` 时，如果不同时传 `--new-workspace local|worktree`，
新 agent 的真实 `Cwd` 会静默落回**调用者自己的 workspace**，而不是 `--cwd` 指定的路径。
`--json` 的返回体里 `cwd` 字段甚至也显示调用者的路径，不会提前暴露这个问题。

**影响**：容易在没有报错的情况下把子 agent 起到错误的目录——这本身就是一种"静默"
失效，和整个项目要防的失效模式同构。本轮通过显式加 `--new-workspace local` 规避。

**请求**：`--cwd` 与已注册 workspace 冲突时至少应该报警告，而不是静默忽略。

---

## 参考

- 已核实的完整 CLI 事实清单：`tasks/active/paseo-companion-manager-skill-20260808/DISPATCH-CODEX-SERVICE.md` §1
- ARCP 侧仍在生效的规避方式：`skills/agent-runtime-control-panel/runtime/UPSTREAM.md`（二者应对照读）
