# opencode-slave

> 将 OpenCode 封装为 Claude Code 插件（MCP + Skill），像调用服务器一样使用 OpenCode 的 AI 编程能力。

## 项目目的

OpenCode 提供了 `opencode serve` 命令，可以在本地启动一个 HTTP API 服务，暴露完整的会话管理、消息发送、文件操作等接口。

本仓库的目标是：

1. **MCP Server**：将 OpenCode serve API 包装为 MCP（Model Context Protocol）工具，让 Claude Code 可以直接调用 OpenCode 执行编程任务
2. **Skill**：提供用户可调用的斜杠命令（`/opencode:task`、`/opencode:status` 等），统一调度 OpenCode 完成复杂任务
3. **Agent**：提供专用子代理（`opencode-agent`），作为任务转发的执行层

## 架构概览

```
Claude Code
    │
    ├── /opencode:task        ← 用户命令（commands/）
    ├── /opencode:status
    │
    ▼
scripts/opencode-companion.mjs  ← 核心运行时（直接通过 Bash 调用）
    │  管理 opencode serve 进程
    │  通过 HTTP API 创建会话、发送消息、流式读取输出
    │
    ▼
opencode serve               ← OpenCode HTTP API (localhost)
    │  POST /session/
    │  POST /session/:id/message
    │  GET  /session/:id/message (SSE)
    │  POST /session/:id/abort
    └── ...
```

## OpenCode Serve API

OpenCode 通过 `opencode serve` 启动本地 HTTP 服务：

```bash
opencode serve --port 4321 --hostname 127.0.0.1
```

关键端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/global/health` | 健康检查 |
| POST | `/session/` | 创建新会话 |
| GET | `/session/` | 列出所有会话 |
| POST | `/session/:id/message` | 发送消息（流式） |
| POST | `/session/:id/prompt_async` | 异步发送消息 |
| GET | `/session/:id/message` | 获取会话消息 |
| POST | `/session/:id/abort` | 中止进行中的任务 |
| GET | `/event` | 订阅实例事件（SSE） |
| GET | `/global/event` | 订阅全局事件（SSE） |

实例通过 `?directory=/path/to/project` 或 `x-opencode-directory` header 区分。

## 目录结构

```
opencode-slave/
├── .claude-plugin/
│   └── plugin.json           # 插件元数据
├── commands/
│   ├── task.md               # /opencode:task - 委托编程任务
│   ├── status.md             # /opencode:status - 查看任务状态
│   └── serve.md              # /opencode:serve - 启动/停止 serve
├── skills/
│   └── opencode/
│       └── SKILL.md          # 统一技能：调用、提示、结果处理、运行时合约
├── agents/
│   └── opencode-agent.md     # 子代理：转发任务到 OpenCode
├── scripts/
│   └── opencode-companion.mjs  # 核心：进程管理 + HTTP API 客户端
├── hooks/
│   └── hooks.json            # 生命周期钩子（SessionStart/End）
├── schemas/
│   └── task-output.schema.json  # 输出格式验证
└── README.md
```

## Harness 框架使用

本项目遵循 Anthropic Harness Engineering 规范，使用 Claude Code 插件体系构建：

### 插件注册

将本仓库路径添加到 `~/.claude/settings.json`：

```json
{
  "plugins": [
    { "source": "local", "path": "/path/to/opencode-slave" }
  ]
}
```

### 命令格式（commands/）

每个命令是带 YAML frontmatter 的 Markdown 文件：

```yaml
---
description: 命令描述
argument-hint: '[flags] [args]'
allowed-tools: Bash
---

命令的行为说明（Markdown prose）...
```

### Skill 格式（skills/）

内部 Skill 提供可复用的行为合约：

```yaml
---
name: opencode
description: OpenCode 调用、提示、结果处理、运行时合约
user-invocable: false
---

行为规则说明...
```

### Agent 格式（agents/）

子代理定义执行层：

```yaml
---
name: opencode-agent
description: 转发任务到 OpenCode serve API
model: sonnet
tools: Bash
skills:
  - opencode
---

转发逻辑说明...
```

### Hooks（hooks/）

会话生命周期钩子，用于管理 OpenCode serve 进程：

```json
{
  "hooks": [
    { "event": "SessionStart", "command": "node scripts/opencode-companion.mjs ensure-serve" },
    { "event": "SessionEnd",   "command": "node scripts/opencode-companion.mjs cleanup" }
  ]
}
```

## 本地开发

### 前置条件

- Node.js 18+
- OpenCode CLI 已安装：`npm install -g opencode` 或 `brew install anomalyco/tap/opencode`
- Claude Code CLI

### 运行测试

```bash
# 验证 OpenCode serve 是否可用
node scripts/opencode-companion.mjs check

# 手动启动 serve（调试用）
opencode serve --port 4321

# 发送测试任务
node scripts/opencode-companion.mjs task "帮我写一个 hello world 函数"

# 查看任务状态
node scripts/opencode-companion.mjs status
```

### 本地安装插件

```bash
# 在 Claude Code 中加载本地插件
claude plugin install ./
```

## 与 Codex 插件的对比

| 特性 | Codex 插件 | OpenCode 插件（本项目） |
|------|-----------|------------------------|
| 后端 | Codex CLI (`codex mcp-server`) | OpenCode HTTP API (`opencode serve`) |
| 通信协议 | stdio MCP | HTTP REST + SSE |
| 任务执行 | 前台/后台作业 | 会话消息流 |
| 进程管理 | Broker 进程 | companion 管理 serve 进程 |
| 输出流 | 事件流 → broker | Server-Sent Events |
